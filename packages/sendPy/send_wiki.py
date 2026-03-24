import os
import wikipedia

from discord_http_client import post_discord_or_throw
from wiki_page_resolver import resolve_page_with_disambiguation, SELECTION_RANDOM

# Discord Webhook URLs
WIKI_DISCORD_WEBHOOK_URL = os.getenv('WIKI_DISCORD_WEBHOOK_URL')
ERROR_WEBHOOK_URL = os.getenv('ERROR_WEBHOOK_URL')


def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【WIKI Channel】Error occurred: {error_message[:1900]}"
    }
    post_discord_or_throw(ERROR_WEBHOOK_URL, error_data)


def main():
    wikipedia.set_lang("ja")

    random_page = wikipedia.random()
    page = resolve_page_with_disambiguation(random_page, selection_rule=SELECTION_RANDOM)

    embed = {
        "title": page.title,
        "url": page.url,
        "description": page.summary[:2048],
    }

    data = {"embeds": [embed]}
    post_discord_or_throw(WIKI_DISCORD_WEBHOOK_URL, data)
    print("Successfully sent message to Discord.")


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        try:
            send_error_to_discord(str(error))
        except Exception as notify_error:
            print(f"Failed to notify error webhook: {notify_error}")
