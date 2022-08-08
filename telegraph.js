const AQUARE_LOCK_TIMEOUT = 2_000; //ms
const CONFIRM_LOCK_TIEMOUT = 2_500; //ms
const DEADLOCK_TIMEOUT = 10_000; //ms
const WAIT_LOCK_TIMEOUT = 30_000; //ms

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sleep = ms => new Promise(r => setTimeout(r, ms));

const bufferToBinString = (buffer) => {
  return [...new Uint8Array(buffer)]
    .map((x) => String.fromCharCode(x))
    .join("");
};

const binStringToBuffer = (binString) => {
  return new Uint8Array([...binString].map((ch) => ch.charCodeAt(0))).buffer;
};

const sha256 = async (content) => {
  return await window.crypto.subtle.digest(
    "SHA-256",
    typeof content === "string" ? encoder.encode(content) : content,
  );
};

const key16FromString = async (key) => new Uint8Array(new Uint8Array(await sha256(key)).slice(0, 16)).buffer;

const randomBuffer = (size) => {
  const array = new Uint8Array(size);
  window.crypto.getRandomValues(array);
  return array.buffer;
};

const aesEncrypt = async (key, content) => {
  const aesKey = await window.crypto.subtle.importKey(
    "raw",
    typeof key === "string"
      ? await key16FromString(key)
      : key,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(randomBuffer(16));
  const data = new Uint8Array(
    await window.crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      aesKey,
      content,
    ),
  );
  const result = new Uint8Array(iv.byteLength + data.byteLength);
  result.set(iv, 0);
  result.set(data, iv.byteLength);
  return result.buffer;
};

const aesDecrypt = async (key, content) => {
  const aesKey = await window.crypto.subtle.importKey(
    "raw",
    typeof key === "string"
      ? await key16FromString(key)
      : key,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  content = new Uint8Array(content);
  const iv = content.subarray(0, 16);
  content = content.subarray(16);
  return await window.crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    aesKey,
    content,
  );
};

const encryptContent = async (accessToken, strContent) => {
  let content = encoder.encode(strContent);
  content = await aesEncrypt(accessToken, content);
  content = btoa(bufferToBinString(content));
  return content;
};
const decryptContent = async (accessToken, b64Content) => {
  let content = binStringToBuffer(atob(b64Content));
  content = await aesDecrypt(accessToken, content);
  content = decoder.decode(content);
  return content;
};

const request = async (method, params, signal = undefined) => {
  let resp;
  try {
    resp = await fetch(`https://api.telegra.ph/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: signal instanceof AbortSignal ? signal : undefined,
    });
  } catch {
    console.error(method, "Network Error.");
    return undefined;
  }
  const data = await resp.json();
  if (data.ok) {
    return data.result;
  } else {
    console.error(method, data.error);
    return undefined;
  }
};

const requestWithTimeout = async (method, params, sleepPms) => {
  const controller = new AbortController();
  const fetchPms = request(method, params, controller.signal).catch((_) => undefined);
  const data = await Promise.race([fetchPms, sleepPms]);
  if (!data) {
    controller.abort();
    return undefined;
  } else {
    return data;
  }
}

export const getItem = async (accessToken, path) => {
  const data = await request("getPage", {
    access_token: accessToken,
    path,
    return_content: true,
  });
  if (data && data.content?.[0]?.children?.[0]) {
    const b64Content = data.content[0].children[0];
    const content = await decryptContent(accessToken, b64Content);
    return content;
  } else {
    return undefined;
  }
};

export const updateItem = async (accessToken, path, title, content) => {
  const b64Content = await encryptContent(accessToken, content);
  const data = await request("editPage", {
    access_token: accessToken,
    path,
    title,
    content: [ { tag: "code", children: [ b64Content ] } ],
  });
  if (data) {
    return true;
  } else {
    return undefined;
  }
};

export const createItem = async (accessToken, title, content) => {
  const b64Content = await encryptContent(accessToken, content);
  const data = await request("createPage", {
    access_token: accessToken,
    title,
    content: [ { tag: "code", children: [ b64Content ] } ],
  });
  if (data) {
    return data.path;
  } else {
    return undefined;
  }
};

export class TelegraDB {
  /** @type {string} */
  #accessToken;
  /** @type {string} */
  #indexPath;
  /** @type {Array<{ title: string, path: string }>} */
  #index;
  constructor(accessToken, indexPath) {
    this.#accessToken = accessToken;
    this.#indexPath = indexPath;
    this.#index = [];
  }
  async #aquireLock() {
    const startTime = Date.now();
    const uuid = window.crypto.randomUUID();
    while (true) {
      if (Date.now() - startTime >= WAIT_LOCK_TIMEOUT) {
        throw Error("Can't aquire lock.")
      }
      const sleepPms = sleep(AQUARE_LOCK_TIMEOUT);
      let data = await requestWithTimeout(
        "getAccountInfo",
        { access_token: this.#accessToken, fields: ["short_name", "author_name"] },
        sleepPms,
      );
      if (!data) {
        await sleep(CONFIRM_LOCK_TIEMOUT);
        continue;
      } else {
        const sinceLockTime = Date.now() - Number.parseInt(data.short_name, 16);
        const lockUUID = data.author_name;
        if (lockUUID !== "" && lockUUID !== uuid && sinceLockTime < DEADLOCK_TIMEOUT) {
          await sleep(CONFIRM_LOCK_TIEMOUT);
          continue;
        }
      }
      const tms = Math.floor(Date.now()).toString(16);
      data = await requestWithTimeout(
        "editAccountInfo",
        { access_token: this.#accessToken, short_name: tms, author_name: uuid },
        sleepPms,
      );
      if (!data) {
        await sleep(CONFIRM_LOCK_TIEMOUT);
        continue;
      }
      // double check
      await sleep(CONFIRM_LOCK_TIEMOUT);
      data = await request(
        "getAccountInfo",
        { access_token: this.#accessToken, fields: ["short_name", "author_name"] },
      );
      if (!data) {
        await sleep(CONFIRM_LOCK_TIEMOUT);
        continue;
      } else {
        const lockUUID = data.author_name;
        if (lockUUID !== uuid) {
          await sleep(CONFIRM_LOCK_TIEMOUT);
          continue;
        }
      }
      break; //locked
    }
  }
  async #releaseLock () {
    await request(
      "editAccountInfo",
      { access_token: this.#accessToken, author_name: "" },
    );
  }
  async withLock (task) {
    await this.#aquireLock();
    try {
      return await task();
    } finally {
      await this.#releaseLock();
    }
  }
  findPathInIndex (title) {
    for (const item of this.#index) {
      if (item.title === title) {
        return item.path;
      }
    }
  }
  async saveIndex () {
    const indexObject = {
      count: this.#index.length,
      index: this.#index,
    }
    const indexJson = JSON.stringify(indexObject);
    await updateItem(this.#accessToken, this.#indexPath, "__index__", indexJson);
  }
  async loadIndex () {
    const indexJson = await getItem(this.#accessToken, this.#indexPath);
    const indexObject = JSON.parse(indexJson);
    this.#index = indexObject.index ?? [];
  }
  async getItem (title) {
    const path = this.findPathInIndex(title);
    if (path) {
      const obj = await getItem(this.#accessToken, path);
      if (obj) {
        return JSON.parse(obj);
      }
    }
  }
  async updateItem (title, value) {
    const path = this.findPathInIndex(title);
    if (path) {
      return await updateItem(this.#accessToken, path, title, JSON.stringify(value));
    }
  }
  async createItem (title, value) {
    if (this.findPathInIndex(title)) {
      return undefined;
    }
    const path = await createItem(this.#accessToken, title, JSON.stringify(value));
    if (path) {
      this.#index.push({ title, path });
      return title;
    }
  }
  getItemTitles () {
    return this.#index.map(item => item.title);
  }
}

export const initTelegraDB = async () => {
  const uid = Math.floor(Date.now()).toString(16);
  let data = await request("createAccount", {
    short_name: uid,
    author_name: "",
  });
  const token = data.access_token;
  console.log("Access Token:", token);
  data = await createItem(token, "__index__", JSON.stringify({count:0,index:[]}));
  console.log("Index Path:", data);
  return { accessToken: token, indexPath: data };
};
