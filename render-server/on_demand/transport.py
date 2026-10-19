"""Private service transport: no redirects, bounded reads and deterministic non-upserting uploads."""

import http.client
import json
from urllib.parse import urlsplit, unquote

from .validation import CHUNK_BYTES, timestamp
import time


def secure_url(value):
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.fragment
        or url.port not in (None, 443)
    ):
        raise ValueError("HTTPS-origin-required")
    return url


def post(url, token, body, apikey=None):
    parsed = secure_url(url)
    connection = http.client.HTTPSConnection(parsed.hostname, timeout=30)
    try:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        if apikey:
            headers["apikey"] = apikey
        connection.request(
            "POST",
            parsed.path,
            body=json.dumps(body, allow_nan=False).encode(),
            headers=headers,
        )
        response = connection.getresponse()
        data = response.read(1024 * 1024 + 1)
        if response.status not in (200, 201, 204) or len(data) > 1024 * 1024:
            raise RuntimeError("private-service-request-failed")
        return json.loads(data) if data else None
    finally:
        connection.close()


class Service:
    def __init__(self, origin, worker_token, supabase_url, service_key):
        self.origin, self.worker_token = origin.rstrip("/"), worker_token
        self.supabase_url, self.service_key = supabase_url.rstrip("/"), service_key
        for url in (origin, supabase_url):
            parsed = secure_url(url)
            if parsed.path not in ("", "/") or parsed.query:
                raise ValueError("origin-not-path")

    def rpc(self, name, args):
        if name not in {"claim_dispatch", "record_dispatch", "reconcile_terminal"}:
            raise ValueError("RPC-not-allowed")
        return post(
            f"{self.supabase_url}/rest/v1/rpc/render_library_{name}",
            self.service_key,
            args,
            self.service_key,
        )

    def claim(self, dispatch, build):
        return post(
            self.origin + "/api/render-library/worker/claim",
            self.worker_token,
            {**dispatch, "workerBuildSha256": build},
        )["claim"]

    def event(self, event):
        return post(
            self.origin + "/api/render-library/worker/events", self.worker_token, event
        )

    def upload(self, event, path):
        receipt = event["receipt"]
        ticket = post(
            self.origin + "/api/render-library/worker/uploads", self.worker_token, event
        )
        key = f"{receipt['jobId']}/{receipt['attemptId']}/{receipt['imageKey']}/{receipt['sha256']}.webp"
        url = secure_url(ticket["uploadUrl"])
        if (
            ticket["bucket"] != "render-library-staging"
            or ticket["objectKey"] != key
            or ticket["overwrite"] is not False
            or ticket["maxBytes"] < receipt["bytes"]
            or timestamp(ticket["expiresAt"]) <= time.time()
            or url.hostname != secure_url(self.supabase_url).hostname
            or unquote(url.path)
            != f"/storage/v1/object/upload/sign/render-library-staging/{key}"
        ):
            raise RuntimeError("upload-ticket-binding")
        connection = http.client.HTTPSConnection(url.hostname, timeout=30)
        try:
            connection.putrequest("PUT", url.path + "?" + url.query)
            for name, value in {
                "Content-Type": "image/webp",
                "Content-Length": str(receipt["bytes"]),
                "x-upsert": "false",
            }.items():
                connection.putheader(name, value)
            connection.endheaders()
            sent = 0
            with path.open("rb") as source:
                while chunk := source.read(CHUNK_BYTES):
                    sent += len(chunk)
                    if sent > receipt["bytes"]:
                        raise RuntimeError("upload-size-changed")
                    connection.send(chunk)
            response = connection.getresponse()
            # A deterministic-object conflict still requires service-side decode/hash verification.
            if sent != receipt["bytes"] or response.status not in (200, 201, 409):
                raise RuntimeError("immutable-upload-failed")
            response.read(16384)
        finally:
            connection.close()
