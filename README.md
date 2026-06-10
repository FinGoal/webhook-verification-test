# Webhook E2E Test App

This standalone app runs the full dev webhook flow:

1. Fetch an auth token.
2. Register the `USER_TAGS_DATA` webhook callback URL.
3. Trigger the test webhook.
4. Receive the webhook at `/v1/datarich-tags-receiver`.
5. Verify `x-webhook-verification` against the raw request body.

## Setup

Requires Node 18+ for built-in `fetch`.

```sh
cd webhook-e2e-test
cp .env.example .env
```

Set these values in `.env`:

```sh
CLIENT_ID=my_client_id
CLIENT_SECRET=my_client_secret
CALLBACK_URL=https://your-ngrok-host.ngrok-free.app/v1/datarich-tags-receiver
```

`WEBHOOK_SIGNING_SECRET` defaults to the last 4 characters of `CLIENT_SECRET`. Set it explicitly only if webhook signing uses a different secret.

Start the app:

```sh
npm start
```

Expose the local port with ngrok or similar. The default local receiver URL is:

```txt
http://localhost:1511/v1/datarich-tags-receiver
```

## Run The E2E Flow

With the server running and `CALLBACK_URL` pointing at this app:

```sh
curl -X POST http://localhost:1511/run-e2e
```

The JSON response includes the status from each outbound API request and the received webhook verification result:

```json
{
  "status": "passed",
  "steps": {
    "webhook": {
      "verified": true,
      "rawBodyLength": 123
    }
  }
}
```

Optional endpoints:

```txt
GET /health
GET /last-run
GET /webhooks
```

To run automatically on startup, set:

```sh
AUTO_RUN_ON_START=true
```
