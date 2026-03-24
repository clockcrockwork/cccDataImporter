import datetime
import os
import random
import wikipedia

from discord_http_client import post_discord_or_throw
from wiki_page_resolver import resolve_page_with_disambiguation, SELECTION_FIRST

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

    today = datetime.datetime.now()
    tomorrow = today + datetime.timedelta(days=1)
    month = tomorrow.strftime("%m")
    day = tomorrow.strftime("%d")

    page_title = f"{month}月{day}日"
    page = resolve_page_with_disambiguation(page_title, selection_rule=SELECTION_FIRST)

    sections = [section for section in page.content.split("\n\n") if section.strip()]
    if not sections:
        raise RuntimeError(f"No sections found in page content: {page_title}")

    random_section = random.choice(sections)
    content_snippet = random_section[:500]
    image_url = page.images[0] if page.images else None

    embed = {
        "title": f"今日は何の日？: {page_title}",
        "description": content_snippet,
        "url": page.url,
        "color": 3447003,
        "timestamp": tomorrow.isoformat(),
        "footer": {
            "text": "Powered by Wikipedia"
        },
    }

    if image_url:
        embed["thumbnail"] = {"url": image_url}

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
