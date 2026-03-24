import os
import sys
import unittest
from unittest.mock import MagicMock, patch

import requests
import wikipedia

CURRENT_DIR = os.path.dirname(__file__)
SEND_PY_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if SEND_PY_DIR not in sys.path:
    sys.path.insert(0, SEND_PY_DIR)

from discord_http_client import post_discord_or_throw
from wiki_page_resolver import resolve_page_with_disambiguation


class TestWikiDisambiguation(unittest.TestCase):
    @patch("wiki_page_resolver.print")
    @patch("wiki_page_resolver.wikipedia.page")
    @patch("wiki_page_resolver.wikipedia.search")
    def test_disambiguation_retry_success(self, mock_search, mock_page, mock_print):
        mock_page.side_effect = [
            wikipedia.exceptions.DisambiguationError("曖昧語", []),
            MagicMock(title="候補1"),
        ]
        mock_search.return_value = ["候補1", "候補2", "候補3", "候補4"]

        result = resolve_page_with_disambiguation("曖昧語", selection_rule="first")

        self.assertEqual(result.title, "候補1")
        self.assertEqual(mock_page.call_count, 2)
        mock_search.assert_called_once_with("曖昧語")
        mock_page.assert_any_call("候補1")
        mock_print.assert_any_call("Disambiguation candidates (top 3) for '曖昧語': ['候補1', '候補2', '候補3']")

    @patch("wiki_page_resolver.wikipedia.page")
    @patch("wiki_page_resolver.wikipedia.search")
    def test_disambiguation_with_zero_candidates_raises(self, mock_search, mock_page):
        mock_page.side_effect = wikipedia.exceptions.DisambiguationError("曖昧語", [])
        mock_search.return_value = []

        with self.assertRaises(RuntimeError) as ctx:
            resolve_page_with_disambiguation("曖昧語", selection_rule="first")

        self.assertIn("No disambiguation candidates", str(ctx.exception))

    @patch("wiki_page_resolver.random.choice", return_value="候補2")
    @patch("wiki_page_resolver.wikipedia.page")
    @patch("wiki_page_resolver.wikipedia.search")
    def test_disambiguation_random_selection(self, mock_search, mock_page, _mock_choice):
        mock_page.side_effect = [
            wikipedia.exceptions.DisambiguationError("曖昧語", []),
            MagicMock(title="候補2"),
        ]
        mock_search.return_value = ["候補1", "候補2", "候補3"]

        result = resolve_page_with_disambiguation("曖昧語", selection_rule="random")

        self.assertEqual(result.title, "候補2")
        mock_page.assert_any_call("候補2")

    def test_disambiguation_invalid_rule_raises(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_page_with_disambiguation("曖昧語", selection_rule="invalid")

        self.assertIn("Unsupported selection_rule", str(ctx.exception))

    def test_disambiguation_invalid_query_raises(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_page_with_disambiguation("", selection_rule="first")

        self.assertIn("non-empty string", str(ctx.exception))


class TestDiscordWebhookClient(unittest.TestCase):
    @patch("discord_http_client.requests.post")
    def test_webhook_failure_raises(self, mock_post):
        mock_post.return_value = MagicMock(status_code=500, text="internal error")

        with self.assertRaises(RuntimeError) as ctx:
            post_discord_or_throw("https://discord.com/api/webhooks/a/b", {"content": "hello"})

        self.assertIn("Failed to send message", str(ctx.exception))

    @patch("discord_http_client.requests.post")
    def test_webhook_network_error_raises(self, mock_post):
        mock_post.side_effect = requests.RequestException("timeout")

        with self.assertRaises(RuntimeError) as ctx:
            post_discord_or_throw("https://discord.com/api/webhooks/a/b", {"content": "hello"})

        self.assertIn("network error", str(ctx.exception))

    def test_webhook_invalid_url_raises(self):
        with self.assertRaises(ValueError) as ctx:
            post_discord_or_throw("http://example.com/webhook", {"content": "hello"})

        self.assertIn("Discord webhook endpoint", str(ctx.exception))

    def test_webhook_invalid_timeout_raises(self):
        with self.assertRaises(ValueError) as ctx:
            post_discord_or_throw("https://discord.com/api/webhooks/a/b", {"content": "hello"}, timeout=0)

        self.assertIn("greater than 0", str(ctx.exception))

    @patch("discord_http_client.requests.post")
    def test_webhook_payload_normalized(self, mock_post):
        mock_post.return_value = MagicMock(status_code=204, text="")
        content = "x" * 2100

        post_discord_or_throw("https://discord.com/api/webhooks/a/b", {"content": content})

        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], "https://discord.com/api/webhooks/a/b")
        self.assertEqual(kwargs["json"]["allowed_mentions"], {"parse": []})
        self.assertEqual(len(kwargs["json"]["content"]), 2000)


if __name__ == "__main__":
    unittest.main()
