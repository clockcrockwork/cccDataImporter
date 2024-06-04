import wikipedia
import requests
import datetime
import os
import random

# Discord Webhook URLs
WIKI_DISCORD_WEBHOOK_URL = os.getenv('WIKI_DISCORD_WEBHOOK_URL')
ERROR_WEBHOOK_URL = os.getenv('ERROR_WEBHOOK_URL')

def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【WIKI Channel】Error occurred: {error_message}"
    }
    headers = {"Content-Type": "application/json"}
    response = requests.post(ERROR_WEBHOOK_URL, json=error_data, headers=headers)
    if response.status_code != 204:
        print(f"Failed to send error message: {response.status_code}, {response.text}")

try:
    # 日本語WikipediaのURLを設定
    wikipedia.set_lang("ja")

    # 当日の日付を取得
    today = datetime.datetime.now()
    month = today.strftime("%m")
    day = (today + datetime.timedelta(days=1)).strftime("%d")

    # Wikipediaの「今日は何の日？」ページを取得
    page_title = f"{month}月{day}日"
    page = wikipedia.page(page_title)

    # 記事のセクションを取得
    content = page.content

    # いくつかの分割方法がありますが、例として "\n\n" を使用
    sections = content.split("\n\n")

    # ランダムに記事を選択
    random_section = random.choice(sections)

    # 記事のタイトルと内容を取得
    title = page_title
    content_snippet = random_section[:500]  # 内容の一部を取得（長すぎる場合があるため）

    # 記事のURLを取得
    article_url = page.url

    # 記事内の画像を取得
    images = page.images
    image_url = images[0] if images else None

    # Embedメッセージの作成
    embed = {
        "title": f"今日は何の日？: {title}",
        "description": content_snippet,
        "url": article_url,
        "color": 3447003,  # Blue
        "timestamp": today.isoformat(),
        "footer": {
            "text": "Powered by Wikipedia"
        },
    }

    if image_url:
        embed["thumbnail"] = {"url": image_url}

    # Webhookデータの作成
    data = {
        "embeds": [embed]
    }

    # Webhookに送信
    headers = {"Content-Type": "application/json"}
    response = requests.post(WIKI_DISCORD_WEBHOOK_URL, json=data, headers=headers)

    if response.status_code == 204:
        print("Successfully sent message to Discord.")
    else:
        raise Exception(f"Failed to send message: {response.status_code}, {response.text}")

except Exception as error:
    # エラー内容をエラーメッセージ用のDiscord Webhookに送信
    send_error_to_discord(str(error))
