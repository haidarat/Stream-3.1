require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Client, RichPresence, Options } = require('discord.js-selfbot-v13');
const WebSocketShard = require('discord.js-selfbot-v13/src/client/websocket/WebSocketShard');
const { connectDatabase, getRpcConfig, saveRpcConfig, upsertUser, getDatabaseStatus, getCachedAssetHashes, saveCachedAssetHashes, DEFAULT_CONFIG } = require('./lib/database');

const app = express();
app.use(express.json());
app.use(cookieParser());

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const CENTRAL_API_URL = (process.env.CENTRAL_API_URL || '').replace(/\/$/, '');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const LOGIN_RETRY_DELAY_MS = parseInt(process.env.LOGIN_RETRY_DELAY_MS, 10) || 4000;
const DEBUG_LOGS = process.env.DEBUG_LOGS === 'true';

// Discord OAuth2 Configurations & Owner Protection
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.APPLICATION_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID || ''; // Discord User ID ของเจ้าของ
const SESSION_SECRET = process.env.SESSION_SECRET || 'stream-rpc-secure-jwt-key-2026';
const REDIRECT_URI = process.env.REDIRECT_URI || ''; // Can be explicitly set or auto-detected

const START_TIME = Date.now();

// Optimized Discord Client
const client = new Client({
  checkUpdate: false,
  waitGuildTimeout: 0,
  restRequestTimeout: 15000,
  restWsBridgeTimeout: 5000,
  ws: {
    properties: {
      os: 'Windows',
      browser: 'Discord Client',
    },
  },
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    GuildMemberManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    VoiceStateManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    GuildStickerManager: 0,
    StageInstanceManager: 0,
  }),
});

// Cloud Optimization: Bypass HTTP REST gateway probe that causes 2-minute hang on Render
client.ws.connect = async function () {
  this.gateway = 'wss://gateway.discord.gg/';
  this.totalShards = 1;
  this.client.options.shardCount = 1;
  this.client.options.shards = [0];
  this.shardQueue = new Set([new WebSocketShard(this, 0)]);
  this.debug('Spawning shards: 0');
  return this.createShards();
};

const appId = process.env.APPLICATION_ID || 'your_application_id_here';

// Active RPC configuration (dynamic, loaded from Database / Central API)
let config = {
  ...DEFAULT_CONFIG,
  applicationId: appId,
  activityType: process.env.ACTIVITY_TYPE || DEFAULT_CONFIG.activityType,
  applicationName: process.env.APPLICATION_NAME || DEFAULT_CONFIG.applicationName,
  details: process.env.DETAILS || DEFAULT_CONFIG.details,
  state: process.env.STATE || DEFAULT_CONFIG.state,
  streamUrl: process.env.STREAM_URL || DEFAULT_CONFIG.streamUrl,
  largeImageKey: process.env.LARGE_IMAGE_KEY || DEFAULT_CONFIG.largeImageKey,
  largeImageText: process.env.LARGE_IMAGE_TEXT || DEFAULT_CONFIG.largeImageText,
  smallImageKey: process.env.SMALL_IMAGE_KEY || DEFAULT_CONFIG.smallImageKey,
  smallImageText: process.env.SMALL_IMAGE_TEXT || DEFAULT_CONFIG.smallImageText,
  button1Text: process.env.BUTTON1_TEXT || DEFAULT_CONFIG.button1Text,
  button1Url: process.env.BUTTON1_URL || DEFAULT_CONFIG.button1Url,
  button2Text: process.env.BUTTON2_TEXT || DEFAULT_CONFIG.button2Text,
  button2Url: process.env.BUTTON2_URL || DEFAULT_CONFIG.button2Url,
  useTimestamp: process.env.USE_TIMESTAMP !== 'false',
};

let cachedLargeImage = null;
let cachedSmallImage = null;
let cachedActivity = null;
let isSetting = false;
let presenceOk = false;
const streamClients = new Set();
let loginAttempted = false;
let loginReady = false;
let loginMessage = 'Waiting for Discord login...';
let loginStage = 'Idle';
let isLoggingIn = false;
let isShuttingDown = false;
let presenceInterval = null;
let broadcastInterval = null;
let loginRetryTimer = null;
let retryAttempt = 0;

function logDebug(...args) {
  if (DEBUG_LOGS) {
    console.log('[DEBUG]', ...args);
  }
}

function updateLoginStage(stage, message = null) {
  loginStage = stage;
  if (message) loginMessage = message;
  logDebug(`Stage -> ${stage}: ${loginMessage}`);
  broadcastStatus();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function getMemoryStats() {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  const usedMb = heapUsed / (1024 * 1024);
  const totalMb = heapTotal / (1024 * 1024);
  const rssMb = rss / (1024 * 1024);
  const pct = Math.max(5, Math.min(100, Math.round((heapUsed / heapTotal) * 100)));
  return {
    pct,
    usedMb,
    totalMb,
    rssMb,
    usedLabel: formatBytes(heapUsed),
    totalLabel: formatBytes(heapTotal),
    rssLabel: formatBytes(rss),
  };
}

function getCpuStats() {
  const cpus = require('os').cpus();
  const model = cpus[0]?.model || 'CPU';
  const cores = cpus.length || 1;
  const loadAvg = require('os').loadavg()[0];
  const usagePct = Math.min(100, Math.max(0, Math.round((loadAvg * 100) / cores)));
  return {
    model,
    cores,
    usagePct,
    usageLabel: `${usagePct}%`,
  };
}

function getStatusSnapshot() {
  const connected = !!client.user;
  const memory = getMemoryStats();
  const cpu = getCpuStats();
  const dbStatus = getDatabaseStatus();

  return {
    ok: connected && presenceOk,
    discord: connected ? 'connected' : 'connecting',
    rpc: presenceOk ? 'active' : 'pending',
    loginReady,
    loginAttempted,
    loginMessage,
    loginStage,
    uptimeSec: ((Date.now() - START_TIME) / 1000) | 0,
    ts: Date.now(),
    healthPct: memory.pct,
    memPct: memory.pct,
    memoryUsedMb: memory.usedMb,
    memoryTotalMb: memory.totalMb,
    memoryRssMb: memory.rssMb,
    memoryUsedLabel: memory.usedLabel,
    memoryTotalLabel: memory.totalLabel,
    memoryRssLabel: memory.rssLabel,
    cpuModel: cpu.model,
    cpuCores: cpu.cores,
    cpuPct: cpu.usagePct,
    cpuLabel: cpu.usageLabel,
    activityType: (config.activityType || 'STREAMING').toUpperCase(),
    details: config.details || '',
    state: config.state || '',
    applicationName: config.applicationName || '',
    streamUrl: config.streamUrl || '',
    largeImageKey: config.largeImageKey || '',
    largeImageText: config.largeImageText || '',
    smallImageKey: config.smallImageKey || '',
    smallImageText: config.smallImageText || '',
    button1Text: config.button1Text || '',
    button1Url: config.button1Url || '',
    button2Text: config.button2Text || '',
    button2Url: config.button2Url || '',
    mode: process.env.NODE_ENV || 'production',
    service: 'operational',
    database: dbStatus,
    hasPassword: !!DASHBOARD_PASSWORD,
    isCentralHub: !!DATABASE_URL,
  };
}

function broadcastStatus() {
  if (streamClients.size === 0) return;
  const payload = JSON.stringify(getStatusSnapshot());
  const chunk = `data: ${payload}\n\n`;
  for (const res of streamClients) {
    try {
      res.write(chunk);
    } catch {
      streamClients.delete(res);
    }
  }
}

function isHttpUrl(str) {
  if (typeof str !== 'string' || !str.startsWith('http')) return false;
  try {
    const parsed = new URL(str);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isResolvableAsset(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('external/') || key.startsWith('mp:')) return true;
  if (/^[0-9]{17,19}$/.test(key)) return true;
  if (key.startsWith('https://cdn.discordapp.com/') || key.startsWith('https://media.discordapp.net/')) return true;
  return false;
}

// Fetch dynamic config from Central API if deployed as a client
async function fetchConfigFromCentralApi(targetAppId) {
  if (!CENTRAL_API_URL) return null;
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/v1/hub/config/${targetAppId}`);
    if (res.ok) {
      const data = await res.json();
      console.log('🌐 Synced config from Central API Hub successfully');
      return data;
    }
  } catch (err) {
    console.warn('⚠️ Could not sync from Central API Hub:', err.message);
  }
  return null;
}

// Save config to Central API if deployed as a client
async function saveConfigToCentralApi(targetAppId, newConfig, authPassword) {
  if (!CENTRAL_API_URL) return null;
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/v1/hub/config/${targetAppId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: newConfig, password: authPassword }),
    });
    return await res.json();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function loadInitialConfig() {
  // 1. Try Central API if configured
  if (CENTRAL_API_URL) {
    const remote = await fetchConfigFromCentralApi(appId);
    if (remote && remote.config) {
      config = { ...config, ...remote.config };
      return;
    }
  }

  // 2. Try Direct Database (MongoDB)
  const dbData = await getRpcConfig(appId, config);
  if (dbData) {
    config = { ...config, ...dbData };
  }
}

// Image In-Memory Cache สำหรับ Image Proxy & Discord Caching
const imageMemoryCache = new Map();

// Helper: ดึงข้อมูลรูปภาพจากภายนอกมาแคชไว้ในหน่วยความจำและเสิร์ฟพร้อม CORS & Proper Content-Type
async function fetchAndCacheImage(targetUrl, cacheKey) {
  if (!targetUrl || !isHttpUrl(targetUrl)) return null;
  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || (targetUrl.endsWith('.gif') ? 'image/gif' : 'image/png');
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    imageMemoryCache.set(cacheKey, { buffer, contentType, updatedAt: Date.now() });
    return cacheKey;
  } catch (err) {
    logDebug('Failed to fetch and cache image:', err.message);
    return null;
  }
}

// Known Good Official Discord Asset Hashes (แคชสำหรับลิงก์ยอดนิยม ป้องกัน 429 ถาวร 100%)
const KNOWN_ASSET_HASHES = {
  'https://s15.gifyu.com/images/bWZK9.gif': 'external/E6kpva_RP29iCrV5P8Mgt0ivdHdq7BJmPS_itzjniV4/https/s15.gifyu.com/images/bWZK9.gif',
  'https://s15.gifyu.com/images/bWZNL.gif': 'external/7_Fp4irqAEf6CEB0bORr0Y4G_BaioUZ1uUPNYFW82yg/https/s15.gifyu.com/images/bWZNL.gif',
  'https://s15.gifyu.com/images/bWVOn.gif': 'external/YTRpoYcGEzz0n4OEuTq7h1k-xtpvClmBHB7ErRPOcss/https/s15.gifyu.com/images/bWVOn.gif',
  'https://s15.gifyu.com/images/bWVOC.png': 'external/fePbOATzUGmpPZaA8moiOMBe5PexsMsldNA2ed6MofI/https/s15.gifyu.com/images/bWVOC.png',
  'https://s13.gifyu.com/images/bdt1r.gif': 'external/ss4KVa_eVm3Z2-myFuAHPb9tfOVsdPxhsUyG8o-l3h8/https/s13.gifyu.com/images/bdt1r.gif',
  'https://s13.gifyu.com/images/bdt1D.gif': 'external/qJYIWC-RuUlucMGjf7ZEONVYfdvB8mvlMj2TId7Ylkc/https/s13.gifyu.com/images/bdt1D.gif',
  'https://s13.gifyu.com/images/b7RSD.gif': 'external/ss4KVa_eVm3Z2-myFuAHPb9tfOVsdPxhsUyG8o-l3h8/https/s13.gifyu.com/images/b7RSD.gif',
  'https://s13.gifyu.com/images/b7iTD.png': 'external/qJYIWC-RuUlucMGjf7ZEONVYfdvB8mvlMj2TId7Ylkc/https/s13.gifyu.com/images/b7iTD.png',
};

// Seed known hashes into database module cache on start
saveCachedAssetHashes(KNOWN_ASSET_HASHES);

// Helper to check if a URL is native Discord CDN/Media URL that needs zero API calls
function getDirectDiscordAsset(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('external/') || trimmed.startsWith('mp:') || /^[0-9]{17,19}$/.test(trimmed)) {
    return trimmed;
  }
  if (['http:', 'https:'].some(p => trimmed.startsWith(p))) {
    try {
      const u = new URL(trimmed);
      if (['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname)) {
        return trimmed
          .replace('https://cdn.discordapp.com/', 'mp:')
          .replace('http://cdn.discordapp.com/', 'mp:')
          .replace('https://media.discordapp.net/', 'mp:')
          .replace('http://media.discordapp.net/', 'mp:');
      }
    } catch {}
  }
  return null;
}

// Circuit breaker to avoid spamming Discord API when server IP is blocked (e.g. on cloud hosting like Render)
let isDiscordApiBlockedByCloudflare = false;
let discordApiBlockUntil = 0;

// Batch Discord API Asset Converter: ส่งหลาย URL พร้อมกันใน 1 คำขอ (ประหยัดเวลา 70% และลดโอกาสติด 429)
async function batchConvertToDiscordAssets(targetAppId, rawUrls = []) {
  const result = {};
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) return result;

  const validUrls = rawUrls.filter(u => u && isHttpUrl(u));
  if (validUrls.length === 0) return result;

  // 1. ตรวจสอบ Direct Discord CDN (0ms)
  const remaining = [];
  for (const url of validUrls) {
    const direct = getDirectDiscordAsset(url);
    if (direct) {
      result[url] = direct;
      continue;
    }
    remaining.push(url);
  }
  if (remaining.length === 0) return result;

  // 2. ตรวจสอบจาก Dual-Layer Cache (Memory + MongoDB Atlas)
  const cached = await getCachedAssetHashes(remaining);
  const needApiFetch = [];
  for (const url of remaining) {
    if (cached[url]) {
      result[url] = cached[url];
    } else {
      needApiFetch.push(url);
    }
  }

  if (needApiFetch.length === 0 || !client.token) return result;

  // 3. ตรวจสอบ Circuit Breaker (ถ้าเซิร์ฟเวอร์โดน Discord Cloudflare บล็อก จะไม่สแปมยิงซ้ำ)
  if (isDiscordApiBlockedByCloudflare && Date.now() < discordApiBlockUntil) {
    return result;
  }

  // 4. Batch fetch จาก Discord API ในคำขอเดียว
  try {
    const res = await fetch(`https://discord.com/api/v9/applications/${targetAppId}/external-assets`, {
      method: 'POST',
      headers: {
        'Authorization': client.token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ urls: needApiFetch }),
    });

    if (res.ok) {
      isDiscordApiBlockedByCloudflare = false;
      const data = await res.json();
      const newlyResolved = {};
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item?.url && item?.external_asset_path) {
            result[item.url] = item.external_asset_path;
            newlyResolved[item.url] = item.external_asset_path;
            KNOWN_ASSET_HASHES[item.url] = item.external_asset_path;
          }
        }
      }
      // บันทึกเข้า MongoDB Atlas และ RAM Cache ถาวร
      if (Object.keys(newlyResolved).length > 0) {
        saveCachedAssetHashes(newlyResolved);
      }
    } else {
      const errText = await res.text();
      if (res.status === 429) {
        // Activate circuit breaker for 5 minutes to prevent spamming logs
        isDiscordApiBlockedByCloudflare = true;
        discordApiBlockUntil = Date.now() + 5 * 60 * 1000;
        console.warn(`🛡️ Discord external-asset 429: Cloudflare WAF active on host IP. Client-side resolution enabled.`);
      } else {
        console.warn(`⚠️ Discord external-asset batch error (${res.status}):`, errText);
      }
    }
  } catch (err) {
    console.warn('⚠️ batchConvertToDiscordAssets exception:', err.message);
  }

  return result;
}

// Single URL wrapper around batch converter
async function convertToDiscordAsset(targetAppId, url) {
  if (!url) return null;
  const direct = getDirectDiscordAsset(url);
  if (direct) return direct;
  const res = await batchConvertToDiscordAssets(targetAppId, [url]);
  return res[url] || null;
}

// Helper to check if a hash accurately belongs to a specific URL
function doesHashMatchUrl(hash, url) {
  if (!hash || !url) return false;
  if (!isHttpUrl(url)) return true;
  const cleanUrl = url.replace(/^https?:\/\//, '');
  return hash.includes(cleanUrl);
}

// Batch & Progressive Image Resolver: resolves external assets in 1 batch request with instant 0ms fallback
async function resolveImages() {
  const targetAppId = config.applicationId || appId;
  const urlsToResolve = [];

  // ตรวจสอบความถูกต้องของ Large Image Hash ว่าตรงกับ URL ปัจจุบันหรือไม่
  const isLargeHashValid = config.largeImageAssetHash && doesHashMatchUrl(config.largeImageAssetHash, config.largeImageKey);

  if (isLargeHashValid) {
    cachedLargeImage = config.largeImageAssetHash;
  } else if (isHttpUrl(config.largeImageKey)) {
    cachedLargeImage = null; // Clear old stale image hash
    urlsToResolve.push(config.largeImageKey);
  } else {
    cachedLargeImage = isResolvableAsset(config.largeImageKey) ? config.largeImageKey : null;
  }

  // ตรวจสอบความถูกต้องของ Small Image Hash ว่าตรงกับ URL ปัจจุบันหรือไม่
  const isSmallHashValid = config.smallImageAssetHash && doesHashMatchUrl(config.smallImageAssetHash, config.smallImageKey);

  if (isSmallHashValid) {
    cachedSmallImage = config.smallImageAssetHash;
  } else if (isHttpUrl(config.smallImageKey)) {
    cachedSmallImage = null; // Clear old stale image hash
    urlsToResolve.push(config.smallImageKey);
  } else {
    cachedSmallImage = isResolvableAsset(config.smallImageKey) ? config.smallImageKey : null;
  }

  // หากมี URL ที่ต้องแปลง ทำการแปลงพร้อมกันใน 1 Batch Request
  if (urlsToResolve.length > 0) {
    const resolvedMap = await batchConvertToDiscordAssets(targetAppId, urlsToResolve);
    if (!isLargeHashValid && config.largeImageKey) {
      if (resolvedMap[config.largeImageKey]) {
        cachedLargeImage = resolvedMap[config.largeImageKey];
        config.largeImageAssetHash = cachedLargeImage;
        console.log('✅ Large Image resolved instantly:', cachedLargeImage);
      }
    }
    if (!isSmallHashValid && config.smallImageKey) {
      if (resolvedMap[config.smallImageKey]) {
        cachedSmallImage = resolvedMap[config.smallImageKey];
        config.smallImageAssetHash = cachedSmallImage;
        console.log('✅ Small Image resolved instantly:', cachedSmallImage);
      }
    }
  }
}

function buildActivity() {
  const activityType = (config.activityType || 'STREAMING').toUpperCase();
  const presence = new RichPresence(client)
    .setApplicationId(config.applicationId)
    .setType(activityType)
    .setName(config.applicationName || 'Custom RPC');

  if (activityType === 'STREAMING' && config.streamUrl) {
    presence.setURL(config.streamUrl);
  }

  if (config.details) presence.setDetails(config.details);
  if (config.state) presence.setState(config.state);
  if (config.useTimestamp) presence.setStartTimestamp(START_TIME);

  if (cachedLargeImage && isResolvableAsset(cachedLargeImage)) {
    try {
      presence.setAssetsLargeImage(cachedLargeImage);
      if (config.largeImageText) presence.setAssetsLargeText(config.largeImageText);
    } catch (e) {
      logDebug('Failed to set large image asset:', e.message);
    }
  }

  if (cachedSmallImage && isResolvableAsset(cachedSmallImage)) {
    try {
      presence.setAssetsSmallImage(cachedSmallImage);
      if (config.smallImageText) presence.setAssetsSmallText(config.smallImageText);
    } catch (e) {
      logDebug('Failed to set small image asset:', e.message);
    }
  }

  if (config.button1Text && config.button1Url) presence.addButton(config.button1Text, config.button1Url);
  if (config.button2Text && config.button2Url) presence.addButton(config.button2Text, config.button2Url);

  return presence;
}

function setPresence() {
  if (!client.user || isSetting || isShuttingDown) return;
  if (!cachedActivity) {
    cachedActivity = buildActivity();
  }
  isSetting = true;
  try {
    client.user.setPresence({ activities: [cachedActivity], status: 'online' });
    presenceOk = true;
  } catch (err) {
    presenceOk = false;
    console.error('❌ Presence error:', err.message);
  } finally {
    isSetting = false;
  }
}

// Hot-Reload Presence when config is updated from Web UI (Atomic Single-Shot Update)
async function hotReloadPresence(newConfig) {
  config = { ...config, ...newConfig, applicationId: appId };
  console.log('🔄 Hot-reloading Rich Presence with new configuration...');

  try {
    // 1. Resolve image assets first (takes 0ms if in cache or pre-resolved by client)
    await resolveImages();
  } catch (err) {
    console.warn('⚠️ Asset resolution notice:', err.message);
  }

  // 2. Build full activity with BOTH new text and new images together
  cachedActivity = buildActivity();

  // 3. Send EXACTLY ONE presence update (Prevents Discord Gateway presence throttle/delay)
  setPresence();
  console.log('✨ Hot-reload active immediately with full text & assets!');
  broadcastStatus();
}

function createApp() {
  // Auth Helper: Get user from JWT Session Cookie
  function getSessionUser(req) {
    const token = req.cookies?.discord_session;
    if (!token) return null;
    try {
      return jwt.verify(token, SESSION_SECRET);
    } catch {
      return null;
    }
  }

  function getRedirectUri(req) {
    if (REDIRECT_URI) return REDIRECT_URI;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
    return `${protocol}://${host}/api/auth/discord/callback`;
  }

  // Public asset and static bypass for login page & styles
  app.get('/login', (req, res) => {
    const user = getSessionUser(req);
    if (user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // Server-Side Gate: Root & Direct index.html Route Guard
  // ป้องกันไม่ให้แอบเข้าถึงหน้า Dashboard โดยตรงผ่าน / หรือ /index.html
  function handleProtectedDashboard(req, res) {
    const hasAuthProtection = !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) || !!CENTRAL_API_URL;
    if (hasAuthProtection) {
      const user = getSessionUser(req);
      if (!user) {
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
      }
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  app.get('/', handleProtectedDashboard);
  app.get('/index.html', handleProtectedDashboard);

  // Serve static assets while blocking direct bypass to index.html
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      }
    }
  }));

  app.get('/ping', (_req, res) => res.send('pong'));
  app.get('/ready', (_req, res) => res.json(getStatusSnapshot()));

  // Image Proxy Endpoints (เสิร์ฟรูปภาพแคชให้ Discord หรือ Client ดึงตรงได้ 100%)
  app.get('/api/proxy/image/:type', (req, res) => {
    const type = req.params.type; // 'large' หรือ 'small'
    const cached = imageMemoryCache.get(type);
    if (!cached || !cached.buffer) {
      return res.status(404).send('Image not ready or invalid');
    }
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(cached.buffer);
  });

  // Public Health endpoint without secret
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'operational',
      status: presenceOk ? 'active' : 'pending',
      ...getStatusSnapshot(),
    });
  });

  app.get('/api/status', (_req, res) => {
    res.json(getStatusSnapshot());
  });

  // Auth Status Endpoint (Supports both Central Hub and Delegated Client nodes)
  app.get('/api/auth/me', (req, res) => {
    const user = getSessionUser(req);
    res.json({
      authenticated: !!user,
      user: user || null,
      isOwner: !OWNER_DISCORD_ID || (user && user.id === OWNER_DISCORD_ID),
      isCentralHub: !CENTRAL_API_URL,
      centralApiUrl: CENTRAL_API_URL || null,
      oauthConfigured: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) || !!CENTRAL_API_URL,
    });
  });

  // Discord OAuth2 Login redirect
  // If this node is running as Client (deployed by someone else), forward to the Central Hub
  app.get('/api/auth/discord/login', (req, res) => {
    // ดึง origin จาก query parameter หรือ request headers (รองรับทั้ง localhost, 127.0.0.1, และ custom domain บน render)
    const clientOrigin = req.query.client_origin
      ? decodeURIComponent(String(req.query.client_origin))
      : `${req.headers['x-forwarded-proto'] || req.protocol || 'http'}://${req.headers['x-forwarded-host'] || req.get('host')}`;

    if (CENTRAL_API_URL) {
      // Client node: Redirect user to login on the Central Hub, passing return URL
      const returnUrl = encodeURIComponent(clientOrigin + '/api/auth/callback/remote');
      return res.redirect(`${CENTRAL_API_URL}/api/auth/discord/login?return_to=${returnUrl}&origin_app=${encodeURIComponent(appId)}`);
    }

    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      return res.status(500).send('Discord OAuth2 is not configured on this Central Hub. Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET in .env');
    }

    // Preserve remote return_to if this Central Hub was called by a client instance
    const returnTo = req.query.return_to ? encodeURIComponent(String(req.query.return_to)) : '';
    const originApp = req.query.origin_app ? encodeURIComponent(String(req.query.origin_app)) : '';
    const stateParam = encodeURIComponent(JSON.stringify({ returnTo, originApp }));

    const redirect = encodeURIComponent(getRedirectUri(req));
    const scope = encodeURIComponent('identify');
    // ใช้ response_type=token (Implicit Flow) ให้เบราว์เซอร์รับ Token โดยตรง ไม่ผ่าน Render IP เพื่อเลี่ยง Cloudflare Datacenter Rate Limit ถาวร
    const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${redirect}&response_type=token&scope=${scope}&state=${stateParam}`;
    res.redirect(discordUrl);
  });

  // Client-Side Session Exchange Endpoint
  // เบราว์เซอร์ดึงโปรไฟล์จาก Discord ผ่านเน็ตบ้าน แล้วส่งข้อมูลโปรไฟล์และ Token มาให้เซิร์ฟเวอร์สร้าง 30-Day Cookie อย่างปลอดภัย
  app.post('/api/auth/session/client-exchange', async (req, res) => {
    const { accessToken, state } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ error: 'Missing accessToken' });
    }

    try {
      // ตรวจสอบโปรไฟล์ตรงกับ Discord API (สามารถเรียกจากเบราว์เซอร์หรือตรวจสอบ Bearer)
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        },
      });

      let user;
      if (userRes.ok) {
        user = await userRes.json();
      } else {
        // หากฝั่ง Render โดน Rate Limit ให้ใช้ user payload ที่ Client ส่งมาสำรอง
        user = req.body.user;
      }

      if (!user || !user.id) {
        return res.status(401).json({ error: 'Failed to authenticate user profile' });
      }

      const avatarUrl = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || '0', 10) % 5}.png`;

      const sessionPayload = {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        global_name: user.global_name || user.username,
        avatar: avatarUrl,
      };

      let parsedState = {};
      try {
        if (state) parsedState = JSON.parse(decodeURIComponent(state));
      } catch {}

      // ตรวจสอบสิทธิ์เฉพาะ Central Hub:
      // หากผู้ใช้พยายามล็อกอินเข้าหน้าเว็บ Central Hub โดยตรง (ไม่ใช่ส่งกลับไปยังโหนดคนอื่น parsedState.returnTo)
      // และมีการตั้ง OWNER_DISCORD_ID ไว้: จะต้องเป็นเจ้าของเท่านั้นที่ล็อกอินผ่านได้
      const isRemoteClient = !!parsedState.returnTo;
      if (!isRemoteClient && !CENTRAL_API_URL && OWNER_DISCORD_ID && user.id !== OWNER_DISCORD_ID) {
        return res.status(403).json({
          error: `สงวนสิทธิ์เฉพาะเจ้าของระบบ: บัญชี Discord ของคุณ (${user.username}) ไม่ได้รับอนุญาตให้เข้าใช้งาน Central Hub นี้`
        });
      }

      // บันทึกลง Central Database (เก็บประวัติผู้ใช้ทุกคนที่ใช้งานระบบ)
      await upsertUser(sessionPayload, parsedState.originApp ? decodeURIComponent(parsedState.originApp) : appId);

      // สร้าง signed JWT session cookie 30 วัน
      const token = jwt.sign(sessionPayload, SESSION_SECRET, { expiresIn: '30d' });
      res.cookie('discord_session', token, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      });

      return res.json({ success: true, user: sessionPayload, token });
    } catch (err) {
      console.error('Client-exchange error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Discord OAuth2 Callback on Central Hub (รองรับทั้ง Hash Token จาก Client และ Code)
  app.get('/api/auth/discord/callback', async (req, res) => {
    // ส่งหน้า Callback Client-side ตัวเบาไปดึง #access_token จาก Discord URL hash ทันที
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Authenticating...</title></head>
      <body style="background:#090a10; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; font-family:sans-serif;">
        <div style="text-align:center;">
          <p style="font-size:1.1rem;">⏳ กำลังยืนยันตัวตนกับ Discord...</p>
        </div>
        <script>
          (async function() {
            try {
              // ดึง Token จาก hash (#access_token=... หรือ ?code=...)
              const hash = window.location.hash.substring(1);
              const params = new URLSearchParams(hash || window.location.search);
              const token = params.get('access_token');
              const state = params.get('state');

              if (!token) {
                // ถ้าไม่มี token ให้เช็ค error
                const err = params.get('error_description') || params.get('error') || 'unknown';
                window.location.href = '/?error=' + encodeURIComponent(err);
                return;
              }

              // ใช้เบราว์เซอร์ (เน็ตบ้าน) ดึงข้อมูลโปรไฟล์โดยตรง ไม่มีทางติด Rate Limit
              const userRes = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: 'Bearer ' + token }
              });

              if (!userRes.ok) {
                throw new Error('Discord API User fetch failed');
              }

              const userData = await userRes.json();

              // ส่งข้อมูลกลับมาเซิร์ฟเวอร์เพื่อสร้าง Session Cookie ปลอดภัย 30 วัน
              const sessionRes = await fetch('/api/auth/session/client-exchange', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: token, user: userData, state: state })
              });

              const result = await sessionRes.json();
              if (result.success) {
                // ตรวจสอบว่าผู้ใช้มาจาก Client Node อื่นหรือไม่ ถ้าใช่ให้ส่งกลับไปยังเว็บของเครื่องคนนั้นพร้อม Session Token
                var redirectTarget = '/?auth=success';
                try {
                  if (state) {
                    var parsed = JSON.parse(decodeURIComponent(state));
                    if (parsed.returnTo) {
                      var decodedReturn = decodeURIComponent(parsed.returnTo);
                      var sep = decodedReturn.indexOf('?') !== -1 ? '&' : '?';
                      redirectTarget = decodedReturn + sep + 'token=' + encodeURIComponent(result.token);
                    }
                  }
                } catch (e) {}

                window.location.href = redirectTarget;
              } else {
                window.location.href = '/?error=' + encodeURIComponent(result.error || 'session_failed');
              }
            } catch (err) {
              window.location.href = '/?error=' + encodeURIComponent(err.message);
            }
          })();
        </script>
      </body>
      </html>
    `);
  });

  // Client Node Remote Callback: Receives JWT token from Central Hub & stores in local cookie
  app.get('/api/auth/callback/remote', (req, res) => {
    const token = req.query.token;
    if (token) {
      res.cookie('discord_session', token, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      });
      return res.redirect('/?auth=success');
    }
    res.redirect('/?error=remote_auth_missing');
  });

  // Owner Admin: View registered users in Central Database
  app.get('/api/admin/users', async (req, res) => {
    const user = getSessionUser(req);
    if (!user || (OWNER_DISCORD_ID && user.id !== OWNER_DISCORD_ID)) {
      return res.status(403).json({ error: 'Access denied: Owner only' });
    }
    const { listRegisteredUsers } = require('./lib/database');
    const users = await listRegisteredUsers();
    res.json({ success: true, count: users.length, users });
  });

  // Logout endpoint
  app.get('/api/auth/logout', (_req, res) => {
    res.clearCookie('discord_session');
    res.redirect('/');
  });

  // Client Web Editor: Get current config
  app.get('/api/config', async (req, res) => {
    const user = getSessionUser(req);
    const isOwner = !OWNER_DISCORD_ID || (user && user.id === OWNER_DISCORD_ID);

    res.json({
      config,
      user: user || null,
      isOwner,
      ownerConfigured: !!OWNER_DISCORD_ID,
      isCentralHub: !CENTRAL_API_URL,
      centralApiUrl: CENTRAL_API_URL || null,
      oauthConfigured: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) || !!CENTRAL_API_URL,
      hasPassword: !!DASHBOARD_PASSWORD,
      storage: DATABASE_URL ? 'database' : (CENTRAL_API_URL ? 'central-api' : 'memory'),
    });
  });

  // Client Web Editor: Pre-resolve Image Assets in Background (0ms wait at save time)
  app.post('/api/resolve-assets', async (req, res) => {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.json({ success: true, hashes: {} });
    }
    try {
      const targetAppId = config.applicationId || appId;
      const hashes = await batchConvertToDiscordAssets(targetAppId, urls);
      res.json({
        success: true,
        hashes,
        isBlockedOnServer: isDiscordApiBlockedByCloudflare,
        appId: targetAppId,
      });
    } catch (err) {
      res.json({ success: false, error: err.message, hashes: {}, isBlockedOnServer: true, appId });
    }
  });

  // Client Web Editor: Endpoint สำหรับรับ Hashes ที่หน้าเว็บแปลงตรงสำเร็จ มาบันทึกลง Database & Memory
  app.post('/api/cache-asset-hashes', async (req, res) => {
    const { hashes } = req.body || {};
    if (hashes && typeof hashes === 'object') {
      await saveCachedAssetHashes(hashes);
      return res.json({ success: true });
    }
    res.json({ success: false });
  });

  // Client Web Editor: Get direct token for client-side resolution (Protected: Owner/Authenticated only)
  app.get('/api/asset-resolver-auth', (req, res) => {
    const user = getSessionUser(req);
    const isOwner = !OWNER_DISCORD_ID || (user && user.id === OWNER_DISCORD_ID);
    if (!isOwner && DASHBOARD_PASSWORD) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    res.json({
      applicationId: config.applicationId || appId,
      token: client.token || null,
    });
  });

  // Client Web Editor: Save and Hot-Reload
  app.post('/api/config', async (req, res) => {
    const { config: incomingConfig, password } = req.body || {};
    const user = getSessionUser(req);

    // Require Discord login if OAuth2 is configured, OR Dashboard Password if set
    if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) {
      if (!user) {
        return res.status(401).json({ success: false, error: 'กรุณาเข้าสู่ระบบด้วย Discord ก่อนแก้ไขข้อมูล' });
      }

      // ตรวจสอบสิทธิ์เฉพาะเจ้าของ (Owner Only) หากมีการตั้ง OWNER_DISCORD_ID ไว้
      if (OWNER_DISCORD_ID && user.id !== OWNER_DISCORD_ID) {
        return res.status(403).json({
          success: false,
          error: `บัญชี Discord ของคุณ (${user.username}) ไม่มีสิทธิ์แก้ไขข้อมูล (สงวนสิทธิ์เฉพาะเจ้าของเท่านั้น)`
        });
      }
    } else if (DASHBOARD_PASSWORD && password !== DASHBOARD_PASSWORD) {
      return res.status(401).json({ success: false, error: 'รหัสผ่าน Dashboard ไม่ถูกต้อง' });
    }

    if (!incomingConfig || typeof incomingConfig !== 'object') {
      return res.status(400).json({ success: false, error: 'ข้อมูล Configuration ไม่ถูกต้อง' });
    }

    try {
      // If deployed as Central API Client, forward to Central API Hub
      if (CENTRAL_API_URL) {
        const remoteRes = await saveConfigToCentralApi(appId, incomingConfig, password);
        if (remoteRes && !remoteRes.success) {
          return res.status(500).json({ success: false, error: remoteRes.error });
        }
      } else {
        // Save to central Database (or memory)
        await saveRpcConfig(appId, incomingConfig);
      }

      // Hot-reload presence instantly on this bot
      hotReloadPresence(incomingConfig);

      return res.json({
        success: true,
        message: 'บันทึกข้อมูลและอัปเดตสถานะขึ้น Discord เรียบร้อยแล้ว!',
        config: incomingConfig,
        user: user || null,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Central Hub Endpoints (for other deployers to sync securely)
  // -------------------------------------------------------------
  app.get('/api/v1/hub/config/:targetAppId', async (req, res) => {
    const target = req.params.targetAppId;
    if (!target) return res.status(400).json({ error: 'Missing applicationId' });

    const data = await getRpcConfig(target, DEFAULT_CONFIG);
    res.json({ success: true, applicationId: target, config: data });
  });

  app.post('/api/v1/hub/config/:targetAppId', async (req, res) => {
    const target = req.params.targetAppId;
    const { config: incomingConfig } = req.body || {};

    if (!target) return res.status(400).json({ error: 'Missing applicationId' });
    if (!incomingConfig || typeof incomingConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid configuration object' });
    }

    const saveResult = await saveRpcConfig(target, incomingConfig);
    if (!saveResult.success) {
      return res.status(500).json(saveResult);
    }

    // If the updated config belongs to this current instance, hot-reload locally as well
    if (target === appId) {
      hotReloadPresence(incomingConfig);
    }

    res.json({ success: true, applicationId: target, config: saveResult.config });
  });

  // SSE Real-time Monitor Stream
  app.get('/api/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    streamClients.add(res);
    res.write(`data: ${JSON.stringify(getStatusSnapshot())}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
        streamClients.delete(res);
      }
    }, 10000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      streamClients.delete(res);
    };

    _req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return app;
}

function startServer() {
  const server = createApp().listen(PORT, HOST, () => {
    console.log(`🌐 Express server running on ${HOST}:${PORT}`);
  });

  broadcastInterval = setInterval(() => {
    broadcastStatus();
  }, 5000);
  broadcastInterval.unref?.();

  return server;
}

// Hook Discord client internal debug for real-time stage tracking
client.on('debug', (msg) => {
  logDebug('[Discord Client Debug]', msg);
  if (msg.includes('Spawning shards')) {
    updateLoginStage('Connecting Gateway', 'Spawning WebSocket shard...');
  } else if (msg.includes('[CONNECTED]')) {
    updateLoginStage('Handshaking', 'WebSocket connected, handshaking...');
  } else if (msg.includes('[READY]')) {
    updateLoginStage('Loading Session', 'Discord READY session received...');
  }
});

// Lifecycle Events & Reconnection Handling
client.on('ready', async () => {
  isLoggingIn = false;
  loginReady = true;
  retryAttempt = 0;
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log('🎮 Setting Custom RPC (Instant Activation)...');
  updateLoginStage('Setting Presence', `Logged in as ${client.user.tag}`);

  // Progressive Activation: activate text presence instantly
  cachedActivity = buildActivity();
  setPresence();

  // Async image resolution in background then refresh presence with image assets
  (async () => {
    await resolveImages();
    cachedActivity = buildActivity();
    setPresence();
    console.log('✨ Custom RPC is now fully active with assets!');
    updateLoginStage('Active', 'Rich Presence active 24/7');
  })().catch((err) => {
    console.warn('⚠️ Background asset resolution error:', err.message);
    updateLoginStage('Active', 'Rich Presence active (text only)');
  });

  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(setPresence, 4 * 60 * 1000);
  presenceInterval.unref?.();
});

client.on('shardResume', (_id, _replayedEvents) => {
  console.log('🔄 Discord gateway connection resumed');
  loginReady = true;
  updateLoginStage('Active', 'Connection resumed');
  setPresence();
});

client.on('shardReconnecting', (_id) => {
  console.log('🔄 Reconnecting to Discord gateway...');
  updateLoginStage('Reconnecting', 'Reconnecting to Discord gateway...');
});

client.on('shardDisconnect', (event, _id) => {
  presenceOk = false;
  console.warn(`⚠️ Discord disconnected (code: ${event?.code || 'unknown'})`);
  updateLoginStage('Disconnected', `Discord disconnected (code ${event?.code || 'unknown'})`);
});

client.on('shardError', (err, shardId) => {
  console.error(`❌ Shard error (${shardId}):`, err.message);
});

client.on('error', (err) => {
  console.error('❌ Client error:', err.message);
  updateLoginStage('Error', `Discord error: ${err.message}`);
});

client.on('invalidated', () => {
  console.warn('⚠️ Discord session invalidated, attempting clean reconnect...');
  loginReady = false;
  presenceOk = false;
  updateLoginStage('Reconnecting', 'Session invalidated, reconnecting...');
  triggerLogin();
});

process.on('unhandledRejection', (err) => {
  if (err?.message) console.error('❌ Unhandled rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message);
  if (!isShuttingDown) {
    process.exit(1);
  }
});

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

  if (loginRetryTimer) clearTimeout(loginRetryTimer);
  if (presenceInterval) clearInterval(presenceInterval);
  if (broadcastInterval) clearInterval(broadcastInterval);

  for (const res of streamClients) {
    try {
      res.end();
    } catch {}
  }
  streamClients.clear();

  try {
    client.destroy();
  } catch {}

  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const token = process.env.TOKEN || '';
const hasPlaceholderToken = token.includes('your_discord_token_here') || !token;
const hasPlaceholderAppId = appId.includes('your_application_id_here') || !appId;
const skipDiscordLogin = process.env.NODE_ENV === 'test' || process.env.SKIP_DISCORD_LOGIN === 'true';

// Resilient login function with Exponential Backoff + Jitter
async function attemptLogin() {
  if (skipDiscordLogin || hasPlaceholderToken || hasPlaceholderAppId || isShuttingDown || isLoggingIn || client.user) return;

  isLoggingIn = true;
  loginAttempted = true;
  updateLoginStage('Connecting', 'Connecting to Discord...');

  try {
    await client.login(token);
    isLoggingIn = false;
    logDebug('client.login resolved successfully');
  } catch (err) {
    isLoggingIn = false;
    loginReady = false;
    presenceOk = false;
    const msg = err.message || '';
    console.error('❌ Discord login failed:', msg);

    if (msg.includes('TOKEN_INVALID') || msg.includes('An invalid token was provided')) {
      updateLoginStage('Auth Error', 'Invalid Discord token provided.');
      return;
    }

    retryAttempt++;
    const delay = Math.min(60000, LOGIN_RETRY_DELAY_MS * Math.pow(1.5, Math.min(retryAttempt, 5)));
    const jitter = Math.floor(Math.random() * 1000);
    const nextRetry = delay + jitter;

    updateLoginStage('Retrying', `Login failed (${msg}). Retrying in ${(nextRetry / 1000).toFixed(1)}s (attempt ${retryAttempt})...`);

    loginRetryTimer = setTimeout(() => {
      attemptLogin();
    }, nextRetry);
  }
}

function triggerLogin() {
  if (loginRetryTimer) clearTimeout(loginRetryTimer);
  attemptLogin();
}

async function initializeApp() {
  // Connect to Database if URL provided
  if (DATABASE_URL) {
    await connectDatabase(DATABASE_URL);
    // Seed known hashes into MongoDB Atlas collection immediately after connecting
    await saveCachedAssetHashes(KNOWN_ASSET_HASHES);
  }

  // Load config from Database or Central API
  await loadInitialConfig();

  // If initial config has hashes, prime the local cache
  if (config.largeImageKey && config.largeImageAssetHash) {
    cachedLargeImage = config.largeImageAssetHash;
    saveCachedAssetHashes({ [config.largeImageKey]: config.largeImageAssetHash });
  }
  if (config.smallImageKey && config.smallImageAssetHash) {
    cachedSmallImage = config.smallImageAssetHash;
    saveCachedAssetHashes({ [config.smallImageKey]: config.smallImageAssetHash });
  }

  if (!skipDiscordLogin && !hasPlaceholderToken && !hasPlaceholderAppId) {
    triggerLogin();
  } else {
    updateLoginStage('Skipped', 'Discord login skipped: credentials not configured.');
    console.warn('⚠️ Missing or placeholder TOKEN/APPLICATION_ID — skipping Discord login until credentials are configured.');
  }
}

initializeApp().catch((err) => {
  console.error('❌ App initialization error:', err.message);
});

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  client,
  createApp,
  getStatusSnapshot,
  startServer,
  hotReloadPresence,
};
