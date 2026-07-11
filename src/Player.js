import { localStorageGetItem, localStorageSetItem } from "./storage";
import { styled, Grid, Box, Typography, IconButton, CircularProgress, Link } from "@mui/material";
import { useCallback, forwardRef, useState, useEffect, useRef } from "react";
import canAutoplay from "can-autoplay";
import Hls from "hls.js";
import Controls from "./Controls";
import biblethump from "./assets/biblethump.png";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { debounce } from "lodash";
import Stats from "./Stats";
import patreonImg from "./assets/patreon.png";
import { isMobile } from "react-device-detect";

const IDENTIFIER = process.env.REACT_APP_IDENTIFER;
const M3U8_BASE = "https://vigor.angelthump.com",
  MSE = Hls.isSupported(),
  WEBSOCKET_URI = "wss://uws.angelthump.com/ws";
const DEFAULT_LIVE_DELAY = 12;
const MIN_LIVE_DELAY = 9;
const MAX_LIVE_DELAY = 60;
const STALL_RECOVERY_DELAY_MS = 2500;
const SOURCE_RECOVERY_DELAY_MS = 10000;
const MANIFEST_RETRY_BASE_DELAY_MS = 2000;
const MAX_MANIFEST_RECOVERY_ATTEMPTS = 4;

const normalizeLiveDelay = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIVE_DELAY;
  return Math.round(Math.min(MAX_LIVE_DELAY, Math.max(MIN_LIVE_DELAY, numeric)) * 2) / 2;
};

const createHlsOptions = (liveDelay) => ({
  debug: false,
  enableWorker: true,
  startLevel: JSON.parse(localStorageGetItem("level")) ?? undefined,
  liveSyncDuration: liveDelay,
  liveSyncOnStallIncrease: 0,
  liveMaxLatencyDuration: liveDelay + 120,
  maxLiveSyncPlaybackRate: 1,
  maxBufferLength: Math.max(30, liveDelay + 18),
  maxMaxBufferLength: Math.max(90, liveDelay + 60),
  liveSyncMode: "buffered",
  progressive: false, // cause some compability issues related to keyframes
  lowLatencyMode: false,
});

const applyLiveDelay = (hls, liveDelay) => {
  if (!hls || !hls.config) return;
  const requestedBuffer = Math.max(30, liveDelay + 18);

  hls.config.lowLatencyMode = false;
  hls.config.liveSyncDuration = liveDelay;
  hls.config.liveSyncOnStallIncrease = 0;
  hls.config.liveMaxLatencyDuration = liveDelay + 120;
  hls.config.liveMaxLatencyDurationCount = Number.POSITIVE_INFINITY;
  hls.config.maxLiveSyncPlaybackRate = 1;
  hls.config.liveSyncMode = "buffered";
  hls.config.maxBufferLength = Math.max(hls.config.maxBufferLength || 0, requestedBuffer);
  hls.config.maxMaxBufferLength = Math.max(hls.config.maxMaxBufferLength || 0, requestedBuffer + 60);

  try {
    hls.lowLatencyMode = false;
    hls.targetLatency = liveDelay;
  } catch (e) {
    // hls.js builds without writable accessors still use the config above.
  }
};

const getForwardBuffer = (player) => {
  if (!player || !player.buffered) return 0;
  const currentTime = player.currentTime;

  for (let i = 0; i < player.buffered.length; i++) {
    const start = player.buffered.start(i);
    const end = player.buffered.end(i);
    if (currentTime >= start - 0.1 && currentTime <= end + 0.1) return Math.max(0, end - currentTime);
  }
  return 0;
};

const clampToSeekable = (player, requested) => {
  if (!player || !player.seekable || player.seekable.length === 0 || !Number.isFinite(requested)) return null;

  let nearest = null;
  for (let i = 0; i < player.seekable.length; i++) {
    const start = player.seekable.start(i);
    const end = player.seekable.end(i);
    const safeStart = Math.min(end, start + 0.1);
    const safeEnd = Math.max(start, end - 0.1);

    if (requested >= start - 0.5 && requested <= end + 0.5) {
      return Math.min(safeEnd, Math.max(safeStart, requested));
    }

    const candidate = requested < safeStart ? safeStart : safeEnd;
    const distance = Math.abs(candidate - requested);
    if (!nearest || distance < nearest.distance) nearest = { position: candidate, distance };
  }

  return nearest ? nearest.position : null;
};

const getToken = async (channel, usePatreonServers) => {
  const token = await fetch(`https://vigor.angelthump.com/${channel}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Identifier: IDENTIFIER,
    },
    credentials: "include",
    body: JSON.stringify({
      patreon: usePatreonServers,
    }),
  })
    .then((response) => response.json())
    .then((response) => response.token)
    .catch((e) => {
      console.error(e);
      return null;
    });
  return token;
};

export default function Player(props) {
  const { channel, streamData, userData } = props;
  const [live, setLive] = useState(streamData && streamData.type === "live");
  const [player, setPlayer] = useState(null);
  const [hls, setHls] = useState(null);
  const [videoContainer, setVideoContainer] = useState(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [usePatreonServers, setPatreonServers] = useState(JSON.parse(localStorageGetItem("patreon")) || false);
  const [liveDelay, setLiveDelayState] = useState(() => {
    try {
      return normalizeLiveDelay(JSON.parse(localStorageGetItem("liveDelay")));
    } catch (e) {
      return DEFAULT_LIVE_DELAY;
    }
  });
  const [showStats, setShowStats] = useState(false);
  const [playerAPI, setPlayerAPI] = useState({
    fullscreen: false,
    canUsePIP: document.pictureInPictureEnabled,
    pip: false,
    buffering: true,
    paused: true,
  });
  const [showPlayOverlay, setShowPlayOverlay] = useState(false);
  const ws = useRef(null);
  const hlsRef = useRef(null);
  const liveDelayRef = useRef(liveDelay);
  liveDelayRef.current = liveDelay;

  const setLiveDelay = useCallback((value) => {
    const normalized = normalizeLiveDelay(value);
    localStorageSetItem("liveDelay", normalized);
    setLiveDelayState(normalized);
  }, []);

  const videoRef = useCallback((node) => {
    setPlayer(node);
  }, []);

  const videoContainerRef = useCallback((node) => {
    if (node) node.focus();
    setVideoContainer(node);
  }, []);

  useEffect(() => {
    setLive(streamData && streamData.type === "live");
    return;
  }, [streamData]);

  useEffect(() => {
    if (!channel) return;
    const ws_connect = () => {
      ws.current = new WebSocket(WEBSOCKET_URI);
      ws.current.onopen = (evt) => evt.target.send(JSON.stringify({ action: "subscribe", channel: channel }));
      ws.current.onclose = () => setTimeout(ws_connect, 5000);

      ws.current.onmessage = (message) => {
        const jsonObject = JSON.parse(message.data);
        switch (jsonObject.action) {
          case "reload":
            window.location.reload();
            break;
          case "redirect":
            window.location.search = `?channel=${jsonObject.punt_username}`;
            break;
          case "live":
            console.info(`ws sent live: ${jsonObject.live}`);
            setLive(jsonObject.live);
            break;
          default:
            break;
        }
      };
    };
    ws_connect();
    return () => (ws.current = null);
  }, [channel]);

  useEffect(() => {
    if (!player || !channel) return;

    const source = `${M3U8_BASE}/hls/${channel}.m3u8`;
    let disposed = false;
    let currentHls = null;
    let stallRecoveryTimer = null;
    let sourceRecoveryTimer = null;
    let manifestRecoveryTimer = null;
    let manifestRecoveryAttempts = 0;
    let manifestRecoveryInFlight = false;

    const clearStallRecovery = () => {
      if (stallRecoveryTimer !== null) clearTimeout(stallRecoveryTimer);
      if (sourceRecoveryTimer !== null) clearTimeout(sourceRecoveryTimer);
      stallRecoveryTimer = null;
      sourceRecoveryTimer = null;
    };

    const clearManifestRecovery = () => {
      if (manifestRecoveryTimer !== null) clearTimeout(manifestRecoveryTimer);
      manifestRecoveryTimer = null;
    };

    const loadSourceWithFreshToken = async (instance) => {
      const token = await getToken(channel, usePatreonServers);
      if (disposed || hlsRef.current !== instance) return false;
      if (!token) {
        if (usePatreonServers) {
          alert("Not a patron or not logged in!");
          localStorageSetItem("patreon", false);
          setPatreonServers(false);
        }
        return false;
      }

      instance.loadSource(`${source}?token=${token}`);
      instance.startLoad();
      void player.play().catch(() => {});
      return true;
    };

    const scheduleManifestRecovery = (instance) => {
      if (disposed || hlsRef.current !== instance || manifestRecoveryTimer !== null) return;
      if (manifestRecoveryAttempts >= MAX_MANIFEST_RECOVERY_ATTEMPTS) return;

      const delay = MANIFEST_RETRY_BASE_DELAY_MS * Math.pow(2, manifestRecoveryAttempts);
      manifestRecoveryTimer = setTimeout(async () => {
        manifestRecoveryTimer = null;
        if (manifestRecoveryInFlight) {
          scheduleManifestRecovery(instance);
          return;
        }
        manifestRecoveryInFlight = true;
        manifestRecoveryAttempts += 1;
        const recovered = await loadSourceWithFreshToken(instance);
        manifestRecoveryInFlight = false;
        if (!recovered) scheduleManifestRecovery(instance);
      }, delay);
    };

    const scheduleStallRecovery = () => {
      clearStallRecovery();
      const instance = hlsRef.current;
      if (!instance) return;

      stallRecoveryTimer = setTimeout(() => {
        stallRecoveryTimer = null;
        if (
          disposed ||
          hlsRef.current !== instance ||
          player.paused ||
          player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
          getForwardBuffer(player) > 0.5
        ) {
          return;
        }

        try {
          instance.resumeBuffering?.();
          instance.startLoad(player.currentTime);
        } catch (e) {
          console.error(e);
        }

        sourceRecoveryTimer = setTimeout(() => {
          sourceRecoveryTimer = null;
          if (
            disposed ||
            hlsRef.current !== instance ||
            player.paused ||
            player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
            getForwardBuffer(player) > 0.5
          ) {
            return;
          }
          scheduleManifestRecovery(instance);
        }, SOURCE_RECOVERY_DELAY_MS - STALL_RECOVERY_DELAY_MS);
      }, STALL_RECOVERY_DELAY_MS);
    };

    const onFullscreenChange = () => {
      const isInFullScreen =
        (document.fullscreenElement && document.fullscreenElement !== null) ||
        (document.webkitFullscreenElement && document.webkitFullscreenElement !== null) ||
        (document.mozFullScreenElement && document.mozFullScreenElement !== null) ||
        (document.msFullscreenElement && document.msFullscreenElement !== null);
      setPlayerAPI((playerAPI) => ({ ...playerAPI, fullscreen: isInFullScreen }));
    };

    canAutoplay.video({ inline: true }).then(async (obj) => {
      if (disposed) return;
      if (obj.result) return (player.muted = JSON.parse(localStorageGetItem("muted")) || false);

      let mutedAutoplay = await canAutoplay.video({ muted: true, inline: true });
      if (disposed) return;
      if (mutedAutoplay.result) return (player.muted = true);

      //If autoplay && muted autoplay doesn't work, display play overlay.
      setPlayerAPI((playerAPI) => ({ ...playerAPI, buffering: false }));
      setShowPlayOverlay(true);
    });

    player.onvolumechange = () => {
      localStorageSetItem(`volume`, player.volume);
      localStorageSetItem(`muted`, player.muted);
      setPlayerAPI((playerAPI) => ({ ...playerAPI, muted: player.muted, volume: player.volume }));
    };

    player.onplay = () => {
      setShowPlayOverlay(false);
      setPlayerAPI((playerAPI) => ({ ...playerAPI, paused: false }));
    };

    player.onplaying = () => {
      clearStallRecovery();
      manifestRecoveryAttempts = 0;
      setPlayerAPI((playerAPI) => ({ ...playerAPI, buffering: false }));
    };

    player.onwaiting = () => {
      setPlayerAPI((playerAPI) => ({ ...playerAPI, buffering: true }));
      scheduleStallRecovery();
    };

    player.onstalled = scheduleStallRecovery;

    player.onpause = () => {
      clearStallRecovery();
      setPlayerAPI((playerAPI) => ({ ...playerAPI, paused: true, buffering: false }));
      setShowPlayOverlay(true);
    };

    player.onerror = async () => {
      if (player.error && player.error.code === 4) {
        console.info(`Edge is down. Retry..`);
        if (MSE && hlsRef.current) {
          scheduleManifestRecovery(hlsRef.current);
        } else {
          loadNative();
        }
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);

    player.volume = JSON.parse(localStorageGetItem("volume")) || 1;
    setPlayerAPI((playerAPI) => ({ ...playerAPI, source: source, volume: player.volume, muted: player.muted }));

    const loadHLS = () => {
      const instance = new Hls(createHlsOptions(liveDelayRef.current));
      currentHls = instance;
      hlsRef.current = instance;
      setHls(instance);
      instance.attachMedia(player);

      instance.on(Hls.Events.MEDIA_ATTACHED, async () => {
        console.info("HLS attached to media");
        const loaded = await loadSourceWithFreshToken(instance);
        if (!loaded) scheduleManifestRecovery(instance);
      });

      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        manifestRecoveryAttempts = 0;
        clearManifestRecovery();
      });

      instance.on(Hls.Events.FRAG_BUFFERED, () => {
        clearStallRecovery();
      });

      instance.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error(data);
              if (data.details === Hls.ErrorDetails?.MANIFEST_LOAD_ERROR || data.details === "manifestLoadError") {
                scheduleManifestRecovery(instance);
              } else {
                try {
                  instance.resumeBuffering?.();
                  instance.startLoad(player.currentTime);
                } catch (e) {
                  console.error(e);
                }
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error(data);
              instance.recoverMediaError();
              break;
            default:
              if (hlsRef.current === instance) hlsRef.current = null;
              instance.destroy();
              setHls(null);
              setTimeout(() => {
                if (!disposed && !hlsRef.current) loadHLS();
              }, MANIFEST_RETRY_BASE_DELAY_MS);
              break;
          }
        } else {
          switch (data.type) {
            case Hls.ErrorTypes.OTHER_ERROR:
              if (data.details === "levelSwitchError") {
                console.error(data);
                localStorageSetItem(`level`, instance.firstLevel);
              }
              break;
            default:
              console.error(data);
              break;
          }
        }
      });
    };

    const loadNative = async () => {
      const token = await getToken(channel, usePatreonServers);
      if (disposed) return;
      if (!token) {
        if (usePatreonServers) {
          alert("Not a patron or not logged in!");
          setPatreonServers(false);
        }
        return;
      }
      player.src = `${source}?token=${token}`;
    };

    if (MSE) {
      console.info("HLS MODE: MSE");
      loadHLS();
    } else if (player.canPlayType && player.canPlayType("application/vnd.apple.mpegurl")) {
      console.info("HLS MODE: NATIVE");
      loadNative();
    } else {
      console.error("Browser does not support MSE and Native HLS.");
    }

    return () => {
      disposed = true;
      clearStallRecovery();
      clearManifestRecovery();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      player.onvolumechange = null;
      player.onplay = null;
      player.onplaying = null;
      player.onwaiting = null;
      player.onstalled = null;
      player.onpause = null;
      player.onerror = null;
      if (currentHls) currentHls.destroy();
      if (hlsRef.current === currentHls) hlsRef.current = null;
    };
  }, [player, channel, usePatreonServers, live]); // live restarts playback after an offline/online transition

  useEffect(() => {
    const instance = hls;
    if (!player || !instance || hlsRef.current !== instance) return;

    applyLiveDelay(instance, liveDelay);

    const reposition = () => {
      if (hlsRef.current !== instance) return;
      const syncPosition = instance.liveSyncPosition;
      if (!Number.isFinite(syncPosition)) return;
      const target = clampToSeekable(player, syncPosition);
      if (!Number.isFinite(target) || Math.abs(player.currentTime - target) < 0.5) return;

      const resume = !player.paused && !player.ended;
      player.currentTime = target;
      try {
        instance.resumeBuffering?.();
        instance.startLoad(target);
      } catch (e) {
        console.error(e);
      }
      if (resume) void player.play().catch(() => {});
    };

    if (instance.latestLevelDetails) {
      reposition();
      return;
    }

    instance.on(Hls.Events.LEVEL_UPDATED, reposition);
    return () => instance.off(Hls.Events.LEVEL_UPDATED, reposition);
  }, [player, hls, liveDelay]);

  useEffect(() => {
    if (!player) return;

    const interval = setInterval(() => {
      const instance = hlsRef.current;
      if (!instance || !instance.latestLevelDetails || player.readyState === HTMLMediaElement.HAVE_NOTHING) return;

      const latency = Number(instance.latency);
      if (!Number.isFinite(latency) || latency <= 0 || latency >= liveDelay - 1) return;

      const syncPosition = instance.liveSyncPosition;
      if (!Number.isFinite(syncPosition)) return;
      const target = clampToSeekable(player, syncPosition);
      if (!Number.isFinite(target) || Math.abs(player.currentTime - target) < 0.5) return;

      player.currentTime = target;
      try {
        instance.resumeBuffering?.();
        instance.startLoad(target);
      } catch (e) {
        console.error(e);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [player, liveDelay]);

  const disableOverlay = () => {
    if (!overlayVisible) return;
    setOverlayVisible(false);
  };

  const debouncedOverlayHandler = useCallback(debounce(disableOverlay, 6000), []); // eslint-disable-line react-hooks/exhaustive-deps

  const mouseMove = () => {
    debouncedOverlayHandler();
    if (overlayVisible) return;
    setOverlayVisible(true);
  };

  const handleFullscreen = async (e) => {
    if (!player && !videoContainer) return;

    const isInFullScreen =
      (document.fullscreenElement && document.fullscreenElement !== null) ||
      (document.webkitFullscreenElement && document.webkitFullscreenElement !== null) ||
      (document.mozFullScreenElement && document.mozFullScreenElement !== null) ||
      (document.msFullscreenElement && document.msFullscreenElement !== null);

    if (!isInFullScreen) {
      if (videoContainer.requestFullscreen) videoContainer.requestFullscreen({ navigationUI: "hide" });
      else if (videoContainer.mozRequestFullScreen) videoContainer.mozRequestFullScreen({ navigationUI: "hide" });
      else if (videoContainer.webkitRequestFullscreen) videoContainer.webkitRequestFullscreen({ navigationUI: "hide" });
      else if (player.webkitEnterFullScreen) player.webkitEnterFullScreen();

      if (isMobile) window.screen.orientation.lock("landscape").catch((e) => console.error(e));
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  };

  const handlePIP = () => {
    document.pictureInPictureElement ? document.exitPictureInPicture() : player.requestPictureInPicture();
    setPlayerAPI({ ...playerAPI, pip: !playerAPI.pip });
  };

  const onKey = (e) => {
    switch (e.keyCode) {
      case 32: {
        e.preventDefault();
        playerAPI.paused ? player.play() : player.pause();
        break;
      }
      case 77: {
        e.preventDefault();
        player.muted = !playerAPI.muted;
        break;
      }
      case 70: {
        e.preventDefault();
        handleFullscreen();
        break;
      }
      case 37: {
        e.preventDefault();
        const currentTime = player.currentTime;
        if (currentTime - 5 < 0) return (player.currentTime = 0);
        player.currentTime = currentTime - 5;
        break;
      }
      case 39: {
        e.preventDefault();
        const currentTime = player.currentTime;
        if (currentTime + 5 > player.duration) return (player.currentTime = player.duration);
        player.currentTime = currentTime + 5;
        break;
      }
      default: {
        break;
      }
    }
  };

  return (
    <>
      {channel ? (
        <VideoContainer>
          <div tabIndex="-1" onKeyDown={onKey} ref={videoContainerRef} onMouseMove={mouseMove} onMouseLeave={() => setOverlayVisible(false)}>
            <Video onContextMenu={(e) => e.preventDefault()} autoPlay playsInline ref={videoRef} />
            <Box onDoubleClick={handleFullscreen} sx={{ position: "absolute", inset: "0px" }}>
              {!live && (
                <OfflineBanner
                  style={{
                    backgroundImage: `url('${userData && userData.offline_banner_url}')`,
                  }}
                />
              )}
              {playerAPI.buffering && (
                <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
                  <CircularProgress />
                </Box>
              )}
              {!usePatreonServers && overlayVisible && (
                <Box sx={{ right: 0, position: "absolute", userSelect: "none" }}>
                  <Link href={`https://patreon.com/join/angelthump`} target="_blank" rel="noreferrer noopener">
                    <img alt="" src={patreonImg} style={{ maxWidth: "100%", height: "auto" }} />
                  </Link>
                </Box>
              )}
              {showPlayOverlay && (
                <PlayOverlay onClick={() => player.play()}>
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", width: "100%" }}>
                    <Box sx={{ position: "absolute" }}>
                      <IconButton onClick={() => player.play()}>
                        <PlayArrowIcon sx={{ fontSize: 80 }} />
                      </IconButton>
                    </Box>
                  </Box>
                </PlayOverlay>
              )}
              {showStats && <Stats hls={hls} player={player} setShowStats={setShowStats} playerAPI={playerAPI} />}
              <Controls
                player={player}
                playerAPI={playerAPI}
                hls={hls}
                live={live}
                liveDelay={liveDelay}
                setLiveDelay={setLiveDelay}
                overlayVisible={live ? overlayVisible : true}
                handleFullscreen={handleFullscreen}
                handlePIP={handlePIP}
                patreon={usePatreonServers}
                setPatreonServers={setPatreonServers}
                showStats={showStats}
                setShowStats={setShowStats}
                isMobile={isMobile}
                streamData={streamData}
              />
            </Box>
          </div>
        </VideoContainer>
      ) : (
        <Box sx={{ flexGrow: 1 }}>
          <Grid container justifyContent="center" alignItems="center" direction="column" style={{ minHeight: "100vh" }}>
            <Grid item xs={12}>
              <Box sx={{ height: "100px", width: "100px" }}>
                <Image src={biblethump} />
              </Box>
            </Grid>
            <Grid item xs={12}>
              <Typography sx={{ fontWeight: 600 }} variant="h6">
                Hm? Missing arguments.
              </Typography>
            </Grid>
          </Grid>
        </Box>
      )}
    </>
  );
}

const VideoContainer = styled(forwardRef(({ ...props }, ref) => <div {...props} ref={ref} />))`
  background: #000;
  overflow: hidden !important;
  position: absolute !important;
  inset: 0px !important;
`;

const Video = styled(forwardRef(({ ...props }, ref) => <video {...props} ref={ref} />))`
  height: 100%;
  position: absolute;
  width: 100%;
  background: #000;
`;

const OfflineBanner = styled((props) => <div {...props} />)`
  background-position: 50%;
  background-repeat: no-repeat;
  background-size: cover;
  display: flex;
  height: 100%;
  justify-content: center;
  width: 100%;
  position: relative;
`;

const Image = styled((props) => <img {...props} alt="" />)`
  margin: auto;
  display: block;
  max-width: 100%;
  max-height: 100%;
`;

const PlayOverlay = styled((props) => <div {...props} />)`
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  flex-direction: column;
  inset: 0px;
  position: absolute;
  cursor: pointer;
`;
