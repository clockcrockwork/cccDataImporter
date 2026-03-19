from copy import deepcopy
from urllib.parse import urlparse

import requests


ALLOWED_DISCORD_HOST_SUFFIXES = ("discord.com", "discordapp.com")
WEBHOOK_PATH_FRAGMENT = "/api/webhooks/"
MAX_DISCORD_CONTENT_LEN = 2000


def _is_allowed_discord_webhook_url(webhook_url: str) -> bool:
    parsed = urlparse(webhook_url)
    if parsed.scheme != "https":
        return False

    host = (parsed.hostname or "").lower()
    if not any(host == suffix or host.endswith(f".{suffix}") for suffix in ALLOWED_DISCORD_HOST_SUFFIXES):
        return False

    return WEBHOOK_PATH_FRAGMENT in (parsed.path or "")


def _normalize_payload(payload: dict) -> dict:
    normalized = deepcopy(payload)

    # 防御的にメンション抑止（必要時は明示指定で上書き可）
    normalized.setdefault("allowed_mentions", {"parse": []})

    content = normalized.get("content")
    if isinstance(content, str):
        normalized["content"] = content[:MAX_DISCORD_CONTENT_LEN]

    return normalized


def post_discord_or_throw(webhook_url: str, payload: dict, timeout: int = 10) -> None:
    """Post payload to Discord webhook and raise on failures."""
    if not webhook_url:
        raise ValueError("Discord webhook URL is not configured.")
    if not _is_allowed_discord_webhook_url(webhook_url):
        raise ValueError("Webhook URL must be an https Discord webhook endpoint.")
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a dictionary.")
    if timeout <= 0:
        raise ValueError("Timeout must be greater than 0.")

    safe_payload = _normalize_payload(payload)

    try:
        response = requests.post(
            webhook_url,
            json=safe_payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "cccDataImporter/sendPy-discord-client",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Failed to send message due to network error: {exc}") from exc

    if response.status_code != 204:
        raise RuntimeError(
            f"Failed to send message: {response.status_code}, {response.text[:300]}"
        )
