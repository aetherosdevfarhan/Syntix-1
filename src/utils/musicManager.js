const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');
const playdl = require('play-dl');

// ffmpeg-static gives us a bundled ffmpeg binary so we don't depend on the host having one installed.
try {
  const ffmpegPath = require('ffmpeg-static');
  process.env.FFMPEG_PATH = ffmpegPath;
} catch {
  // ffmpeg-static not installed — playback will fail with a clear error from @discordjs/voice.
}

// Optional: a logged-in YouTube cookie makes play-dl noticeably more reliable on cloud hosts
// (Render/Railway/etc. IPs get rate-limited/blocked by YouTube more aggressively than home IPs).
// This does NOT make it bulletproof — YouTube can still block cloud IPs outright — but it helps.
// Set YOUTUBE_COOKIE in your host's environment variables to enable it. Leave unset to skip.
if (process.env.YOUTUBE_COOKIE) {
  playdl.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } })
    .then(() => console.log('[AETHEROS] [music] YouTube cookie loaded.'))
    .catch(err => console.warn('[AETHEROS] [music] Failed to apply YouTube cookie:', err.message));
}

function friendlyStreamError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('sign in') || msg.includes('confirm') || msg.includes('bot')) {
    return "YouTube is blocking this server's streaming requests (common on cloud hosts like Render). " +
      "Try setting a YOUTUBE_COOKIE environment variable, or try a different search/URL.";
  }
  if (msg.includes('private') || msg.includes('unavailable')) {
    return 'That video is private or unavailable.';
  }
  if (msg.includes('age')) {
    return 'That video is age-restricted and needs a signed-in cookie to play — set YOUTUBE_COOKIE.';
  }
  return err.message || 'Unknown playback error.';
}

// guildId -> queue
const queues = new Map();

const EMPTY_CHANNEL_TIMEOUT_MS = 60_000; // leave 60s after everyone else leaves
const IDLE_TIMEOUT_MS = 5 * 60_000;      // leave 5 min after the queue finishes

function getQueue(guildId) {
  return queues.get(guildId) || null;
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return 'Live';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function clearTimers(queue) {
  if (queue.idleTimer) clearTimeout(queue.idleTimer);
  if (queue.emptyTimer) clearTimeout(queue.emptyTimer);
  queue.idleTimer = null;
  queue.emptyTimer = null;
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  clearTimers(queue);
  try { queue.player.stop(true); } catch { /* ignore */ }
  try { queue.connection.destroy(); } catch { /* ignore */ }
  queues.delete(guildId);
}

async function resolveTrack(query, requestedBy) {
  const isUrl = playdl.yt_validate(query) === 'video';

  try {
    if (isUrl) {
      const info = await playdl.video_basic_info(query);
      const details = info.video_details;
      return {
        title: details.title,
        url: details.url,
        durationSeconds: details.durationInSec,
        thumbnail: details.thumbnails?.[details.thumbnails.length - 1]?.url,
        requestedBy
      };
    }

    const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
    if (!results.length) return null;
    const video = results[0];
    return {
      title: video.title,
      url: video.url,
      durationSeconds: video.durationInSec,
      thumbnail: video.thumbnails?.[video.thumbnails.length - 1]?.url,
      requestedBy
    };
  } catch (err) {
    throw new Error(friendlyStreamError(err));
  }
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const next = queue.songs.shift();
  if (!next) {
    queue.nowPlaying = null;
    clearTimers(queue);
    queue.idleTimer = setTimeout(() => destroyQueue(guildId), IDLE_TIMEOUT_MS);
    return;
  }

  clearTimers(queue);
  queue.nowPlaying = next;

  try {
    const stream = await playdl.stream(next.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type || StreamType.Arbitrary,
      inlineVolume: true
    });
    resource.volume?.setVolume((queue.volume ?? 100) / 100);
    queue.player.play(resource);
  } catch (err) {
    console.error('[AETHEROS] [music] Failed to stream track:', err);
    queue.textChannel?.send(`⚠️ Couldn't play **${next.title}** — ${friendlyStreamError(err)}. Skipping.`).catch(() => null);
    return playNext(guildId);
  }
}

async function getOrCreateQueue(guild, voiceChannel, textChannel) {
  let queue = queues.get(guild.id);
  if (queue) return queue;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  queue = {
    guildId: guild.id,
    voiceChannelId: voiceChannel.id,
    textChannel,
    connection,
    player,
    songs: [],
    nowPlaying: null,
    loop: 'off',
    volume: 100,
    idleTimer: null,
    emptyTimer: null
  };
  queues.set(guild.id, queue);

  player.on(AudioPlayerStatus.Idle, () => {
    const q = queues.get(guild.id);
    if (!q) return;
    if (q.loop === 'track' && q.nowPlaying) {
      q.songs.unshift(q.nowPlaying);
    } else if (q.loop === 'queue' && q.nowPlaying) {
      q.songs.push(q.nowPlaying);
    }
    playNext(guild.id);
  });

  player.on('error', (err) => {
    console.error('[AETHEROS] [music] Player error:', err);
    const q = queues.get(guild.id);
    q?.textChannel?.send(`⚠️ Playback error on **${q?.nowPlaying?.title ?? 'current track'}**, skipping.`).catch(() => null);
    playNext(guild.id);
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`[AETHEROS] [music] Voice connection: ${oldState.status} -> ${newState.status}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    queues.delete(guild.id);
    throw new Error(
      "Couldn't establish a stable voice connection in time. This is almost always the hosting " +
      "platform blocking the UDP traffic Discord voice needs (common on Render/Heroku free tiers), " +
      "not a bug in the bot. Check the deploy logs for the [music] Voice connection state lines " +
      "printed just before this to see exactly where it got stuck."
    );
  }

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      destroyQueue(guild.id);
    }
  });

  return queue;
}

async function addToQueue({ guild, member, textChannel, query }) {
  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) throw new Error('Join a voice channel first.');
  if (!voiceChannel.joinable) throw new Error("I don't have permission to join that voice channel.");
  if (!voiceChannel.permissionsFor(guild.members.me)?.has(['Connect', 'Speak'])) {
    throw new Error("I need **Connect** and **Speak** permissions in your voice channel.");
  }

  const existing = queues.get(guild.id);
  if (existing && existing.voiceChannelId !== voiceChannel.id) {
    throw new Error(`I'm already playing music in <#${existing.voiceChannelId}>.`);
  }

  const track = await resolveTrack(query, member.id);
  if (!track) throw new Error("Couldn't find anything for that search.");

  const queue = await getOrCreateQueue(guild, voiceChannel, textChannel);
  clearTimers(queue);
  queue.songs.push(track);

  if (!queue.nowPlaying) {
    await playNext(guild.id);
    return { track, startedPlaying: true };
  }
  return { track, startedPlaying: false, position: queue.songs.length };
}

function skip(guildId) {
  const queue = queues.get(guildId);
  if (!queue || !queue.nowPlaying) throw new Error('Nothing is playing right now.');
  const skipped = queue.nowPlaying;
  queue.player.stop(true);
  return skipped;
}

function stop(guildId) {
  const queue = queues.get(guildId);
  if (!queue) throw new Error("I'm not playing anything right now.");
  destroyQueue(guildId);
}

function pause(guildId) {
  const queue = queues.get(guildId);
  if (!queue?.nowPlaying) throw new Error('Nothing is playing right now.');
  if (!queue.player.pause()) throw new Error('Already paused.');
}

function resume(guildId) {
  const queue = queues.get(guildId);
  if (!queue?.nowPlaying) throw new Error('Nothing is playing right now.');
  if (!queue.player.unpause()) throw new Error('Already playing.');
}

function setVolume(guildId, volume) {
  const queue = queues.get(guildId);
  if (!queue) throw new Error("I'm not playing anything right now.");
  queue.volume = volume;
  const resource = queue.player.state.resource;
  resource?.volume?.setVolume(volume / 100);
}

function setLoop(guildId, mode) {
  const queue = queues.get(guildId);
  if (!queue) throw new Error("I'm not playing anything right now.");
  queue.loop = mode;
}

module.exports = {
  getQueue,
  addToQueue,
  skip,
  stop,
  pause,
  resume,
  setVolume,
  setLoop,
  formatDuration,
  destroyQueue,
  EMPTY_CHANNEL_TIMEOUT_MS
};
