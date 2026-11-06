const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let isConnected = false;

const DEFAULT_CONFIG = {
  activityType: 'STREAMING',
  applicationName: 'YouTube',
  details: '⚡ Stream 3.1 By HA!DARaT.',
  state: '🛡️ Follow instagram : log.horizon.r',
  streamUrl: 'https://www.twitch.tv/haidar_at',
  largeImageKey: 'https://s15.gifyu.com/images/bWVOn.gif',
  largeImageAssetHash: 'external/YTRpoYcGEzz0n4OEuTq7h1k-xtpvClmBHB7ErRPOcss/https/s15.gifyu.com/images/bWVOn.gif',
  largeImageText: '🟢┊ONLINE 24/7',
  smallImageKey: 'https://s15.gifyu.com/images/bWVOC.png',
  smallImageAssetHash: 'external/fePbOATzUGmpPZaA8moiOMBe5PexsMsldNA2ed6MofI/https/s15.gifyu.com/images/bWVOC.png',
  smallImageText: '🟢┊ONLINE 24/7',
  button1Text: '» Github «',
  button1Url: 'https://github.com/haidarat',
  button2Text: '» Stream 3.1 «',
  button2Url: 'https://github.com/haidarat/Stream-3.1.git',
  useTimestamp: false,
};

async function connectDatabase(uri) {
  if (!uri || uri.includes('your_mongodb_uri_here')) {
    console.log('📦 Database URI not configured. Using local in-memory config mode.');
    return null;
  }

  try {
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    db = client.db('custom_rpc');
    isConnected = true;
    console.log('✅ Connected to MongoDB Atlas successfully.');
    return db;
  } catch (err) {
    isConnected = false;
    console.warn(`⚠️ Database connection warning (${err.message}). Running with fallback.`);
    return null;
  }
}

async function getRpcConfig(appId, fallbackConfig = {}, userId = null) {
  const defaults = { ...DEFAULT_CONFIG, ...fallbackConfig, applicationId: appId };

  if (!db || !isConnected) {
    return defaults;
  }

  try {
    const collection = db.collection('rpc_configs');
    const query = userId ? { userId } : { applicationId: appId };
    const doc = await collection.findOne(query);
    if (!doc) {
      // Seed default config into DB for this user/application
      await collection.updateOne(
        query,
        { $setOnInsert: { ...defaults, userId, applicationId: appId, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
      return defaults;
    }
    return { ...defaults, ...doc };
  } catch (err) {
    console.error('❌ Failed to fetch config from database:', err.message);
    return defaults;
  }
}

async function saveRpcConfig(appId, newConfig, userId = null) {
  const sanitized = {
    applicationId: appId,
    ...(userId ? { userId } : {}),
    activityType: (newConfig.activityType || 'STREAMING').toUpperCase(),
    applicationName: newConfig.applicationName || 'YouTube',
    details: newConfig.details || '',
    state: newConfig.state || '',
    streamUrl: newConfig.streamUrl || '',
    largeImageKey: newConfig.largeImageKey || '',
    largeImageAssetHash: newConfig.largeImageAssetHash || '',
    largeImageText: newConfig.largeImageText || '',
    smallImageKey: newConfig.smallImageKey || '',
    smallImageAssetHash: newConfig.smallImageAssetHash || '',
    smallImageText: newConfig.smallImageText || '',
    button1Text: newConfig.button1Text || '',
    button1Url: newConfig.button1Url || '',
    button2Text: newConfig.button2Text || '',
    button2Url: newConfig.button2Url || '',
    useTimestamp: newConfig.useTimestamp !== false,
    updatedAt: new Date(),
  };

  if (db && isConnected) {
    try {
      const collection = db.collection('rpc_configs');
      const query = userId ? { userId } : { applicationId: appId };
      await collection.updateOne(
        query,
        { $set: sanitized },
        { upsert: true }
      );
      return { success: true, config: sanitized, storage: 'database' };
    } catch (err) {
      console.error('❌ Failed to save config to database:', err.message);
      return { success: false, error: err.message };
    }
  }

  return { success: true, config: sanitized, storage: 'memory' };
}

async function upsertUser(userProfile, appId = null) {
  if (!db || !isConnected || !userProfile?.id) return null;
  try {
    const collection = db.collection('users');
    const updateDoc = {
      $set: {
        username: userProfile.username,
        discriminator: userProfile.discriminator,
        global_name: userProfile.global_name || userProfile.username,
        avatar: userProfile.avatar,
        lastLoginAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    };

    if (appId) {
      updateDoc.$addToSet = { deployedAppIds: appId };
    }

    await collection.updateOne({ id: userProfile.id }, updateDoc, { upsert: true });
  } catch (err) {
    console.warn('⚠️ User upsert warning:', err.message);
  }
}

async function listRegisteredUsers() {
  if (!db || !isConnected) return [];
  try {
    const collection = db.collection('users');
    return await collection.find({}).sort({ lastLoginAt: -1 }).limit(100).toArray();
  } catch (err) {
    console.warn('⚠️ Could not list users:', err.message);
    return [];
  }
}

// -------------------------------------------------------------
// Persistent Asset Cache (MongoDB Atlas + In-Memory Fast Cache)
// -------------------------------------------------------------
const MEMORY_ASSET_CACHE = new Map();

async function getCachedAssetHashes(urls = []) {
  const result = {};
  if (!Array.isArray(urls) || urls.length === 0) return result;

  const missingUrls = [];
  for (const url of urls) {
    if (!url || typeof url !== 'string') continue;
    if (MEMORY_ASSET_CACHE.has(url)) {
      result[url] = MEMORY_ASSET_CACHE.get(url);
    } else {
      missingUrls.push(url);
    }
  }

  if (missingUrls.length > 0 && db && isConnected) {
    try {
      const collection = db.collection('asset_cache');
      const docs = await collection.find({ url: { $in: missingUrls } }).toArray();
      for (const doc of docs) {
        if (doc.url && doc.hash) {
          result[doc.url] = doc.hash;
          MEMORY_ASSET_CACHE.set(doc.url, doc.hash);
        }
      }
    } catch (err) {
      console.warn('⚠️ Database asset cache read warning:', err.message);
    }
  }

  return result;
}

async function saveCachedAssetHashes(urlHashMap = {}) {
  if (!urlHashMap || typeof urlHashMap !== 'object') return;

  const entries = Object.entries(urlHashMap);
  if (entries.length === 0) return;

  // Cache in Memory immediately (0ms access)
  for (const [url, hash] of entries) {
    if (url && hash) {
      MEMORY_ASSET_CACHE.set(url, hash);
    }
  }

  // Persist to MongoDB Atlas asynchronously
  if (db && isConnected) {
    try {
      const collection = db.collection('asset_cache');
      const bulkOps = entries.map(([url, hash]) => ({
        updateOne: {
          filter: { url },
          update: { $set: { url, hash, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
          upsert: true,
        },
      }));
      await collection.bulkWrite(bulkOps, { ordered: false });
    } catch (err) {
      console.warn('⚠️ Database asset cache write warning:', err.message);
    }
  }
}

function getDatabaseStatus() {
  return {
    connected: isConnected,
    type: db ? 'MongoDB' : 'In-Memory / Central API',
  };
}

module.exports = {
  connectDatabase,
  getRpcConfig,
  saveRpcConfig,
  upsertUser,
  listRegisteredUsers,
  getDatabaseStatus,
  getCachedAssetHashes,
  saveCachedAssetHashes,
  DEFAULT_CONFIG,
};
