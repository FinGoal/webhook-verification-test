const crypto = require("crypto");
const path = require("path");
const express = require("express");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();

const PORT = Number(process.env.PORT || 1511);
const API_BASE_URL =
  process.env.API_BASE_URL || "https://findmoney-dev.fingoal.com/v3";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TENANT_ID = process.env.TENANT_ID
const CALLBACK_URL = process.env.CALLBACK_URL;
const WEBHOOK_TYPE = process.env.WEBHOOK_TYPE || "USER_TAGS_DATA";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/v1/datarich-tags-receiver";
const WEBHOOK_SIGNING_SECRET =
  process.env.WEBHOOK_SIGNING_SECRET || getDefaultWebhookSigningSecret(CLIENT_SECRET);
const E2E_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 30000);
const AUTO_RUN_ON_START = process.env.AUTO_RUN_ON_START === "true";

const receivedWebhooks = [];
const webhookWaiters = new Set();
let activeRunPromise = null;
let lastRun = null;

const captureRawBody = (req, res, buf) => {
  req.rawBody = Buffer.from(buf);
};

app.use(express.json({ limit: "50mb", verify: captureRawBody }));
app.use(
  express.urlencoded({
    limit: "50mb",
    extended: true,
    parameterLimit: 50000,
    verify: captureRawBody,
  })
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    callbackPath: WEBHOOK_PATH,
    callbackUrl: CALLBACK_URL,
    webhookType: WEBHOOK_TYPE,
    lastRun,
    receivedWebhookCount: receivedWebhooks.length,
  });
});

app.get("/webhooks", (req, res) => {
  res.json(receivedWebhooks);
});

app.get("/last-run", (req, res) => {
  res.json(lastRun || { status: "not_started" });
});

app.post("/run-e2e", async (req, res) => {
  try {
    const result = await runE2E();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      lastRun,
    });
  }
});

app.post(WEBHOOK_PATH, (req, res) => {
  const verificationHeader = req.get("x-webhook-verification");
  const rawBody = req.rawBody;
  const rawBodyLength = rawBody ? rawBody.length : 0;

  const digest =
    rawBody && WEBHOOK_SIGNING_SECRET
      ? crypto
          .createHmac("sha256", WEBHOOK_SIGNING_SECRET)
          .update(rawBody)
          .digest("hex")
      : null;

  const verified =
    Boolean(verificationHeader) &&
    Boolean(digest) &&
    timingSafeEqual(digest, verificationHeader);

  const received = {
    receivedAt: new Date().toISOString(),
    webhookType: req.body && req.body.webhook_type,
    verificationHeader,
    digest,
    verified,
    rawBodyLength,
    body: req.body,
  };

  receivedWebhooks.push(received);
  console.log("Webhook received", JSON.stringify(received, null, 2));

  for (const waiter of webhookWaiters) {
    waiter(received);
  }
  webhookWaiters.clear();

  if (!verificationHeader) {
    res.status(401).json({ ok: false, error: "Missing x-webhook-verification" });
    return;
  }

  if (!verified) {
    res.status(401).json({ ok: false, error: "Webhook verification failed" });
    return;
  }

  res.status(201).json({ ok: true });
});

async function runE2E() {
  if (activeRunPromise) {
    return activeRunPromise;
  }

  activeRunPromise = runE2EInternal();

  try {
    return await activeRunPromise;
  } finally {
    activeRunPromise = null;
  }
}

async function runE2EInternal() {
  validateConfig();
  let webhookWaiter;

  lastRun = {
    status: "running",
    startedAt: new Date().toISOString(),
    callbackUrl: CALLBACK_URL,
    webhookType: WEBHOOK_TYPE,
  };

  try {
    console.log("Requesting auth token...");
    const auth = await requestJson(`${API_BASE_URL}/authentication`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        tenant_id: TENANT_ID
      }),
    });
    const token = extractAuthToken(auth.data);
    console.log("Auth token received", mask(token));

    console.log("Registering webhook configuration...");
    const register = await requestJson(`${API_BASE_URL}/webhook-configurations`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        webhook_type: WEBHOOK_TYPE,
        callback_url: CALLBACK_URL,
      }),
    });
    console.log("Webhook configuration registered");

    console.log("Triggering test webhook...");
    webhookWaiter = createWebhookWaiter(E2E_TIMEOUT_MS);
    const trigger = await requestJson(
      `${API_BASE_URL}/webhook-configurations/test`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          client_id: CLIENT_ID,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          webhook_type: WEBHOOK_TYPE,
        }),
      }
    );
    console.log("Test webhook trigger request accepted");

    const webhook = await webhookWaiter.promise;

    lastRun = {
      ok: webhook.verified,
      status: webhook.verified ? "passed" : "failed",
      startedAt: lastRun.startedAt,
      finishedAt: new Date().toISOString(),
      callbackUrl: CALLBACK_URL,
      webhookType: WEBHOOK_TYPE,
      steps: {
        auth: summarizeResponse(auth),
        register: summarizeResponse(register),
        trigger: summarizeResponse(trigger),
        webhook: {
          receivedAt: webhook.receivedAt,
          rawBodyLength: webhook.rawBodyLength,
          verificationHeader: webhook.verificationHeader,
          digest: webhook.digest,
          verified: webhook.verified,
          body: webhook.body,
        },
      },
    };

    return lastRun;
  } catch (error) {
    if (webhookWaiter) {
      webhookWaiter.cancel();
    }

    lastRun = {
      ok: false,
      status: "failed",
      startedAt: lastRun.startedAt,
      finishedAt: new Date().toISOString(),
      callbackUrl: CALLBACK_URL,
      webhookType: WEBHOOK_TYPE,
      error: error.message,
    };

    throw error;
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = parseResponseBody(text);

  if (!response.ok) {
    const error = new Error(
      `Request failed: ${options.method} ${url} -> ${response.status}`
    );
    error.response = { status: response.status, data };
    throw error;
  }

  return {
    status: response.status,
    data,
  };
}

function parseResponseBody(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function extractAuthToken(data) {
  const token =
    data &&
    (data.access_token ||
      data.accessToken ||
      data.token ||
      data.bearer_token ||
      (data.data &&
        (data.data.access_token ||
          data.data.accessToken ||
          data.data.token ||
          data.data.bearer_token)));

  if (!token) {
    throw new Error(`Could not find auth token in response: ${JSON.stringify(data)}`);
  }

  return token;
}

function createWebhookWaiter(timeoutMs) {
  let settled = false;
  let timer;
  let waiter;

  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      settled = true;
      webhookWaiters.delete(waiter);
      reject(new Error(`Timed out waiting ${timeoutMs}ms for webhook callback`));
    }, timeoutMs);

    waiter = (webhook) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(webhook);
    };

    webhookWaiters.add(waiter);
  });

  return {
    promise,
    cancel: () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      webhookWaiters.delete(waiter);
    },
  };
}

function summarizeResponse(response) {
  return {
    status: response.status,
    data: response.data,
  };
}

function validateConfig() {
  const missing = [];

  if (!CLIENT_ID) missing.push("CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("CLIENT_SECRET");
  if (!CALLBACK_URL) missing.push("CALLBACK_URL");
  if (!WEBHOOK_SIGNING_SECRET) missing.push("WEBHOOK_SIGNING_SECRET");

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function getDefaultWebhookSigningSecret(clientSecret) {
  return clientSecret ? clientSecret.slice(-4) : undefined;
}

function timingSafeEqual(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected));
  const actualBuffer = Buffer.from(String(actual));

  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function mask(value) {
  if (!value || value.length <= 12) {
    return "[redacted]";
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

const server = app.listen(PORT, () => {
  console.log(`Webhook e2e test app listening on ${PORT}`);
  console.log(`Receiver endpoint: ${WEBHOOK_PATH}`);

  if (AUTO_RUN_ON_START) {
    runE2E()
      .then((result) => {
        console.log("E2E result", JSON.stringify(result, null, 2));
      })
      .catch((error) => {
        console.error("E2E failed", error);
      });
  }
});

process.on("SIGINT", () => {
  server.close(() => {
    process.exit(0);
  });
});
