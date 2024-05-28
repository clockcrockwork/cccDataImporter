import wikipedia
import requests
import os

# Discord Webhook URLs
WIKI_DISCORD_WEBHOOK_URL = os.getenv('WIKI_DISCORD_WEBHOOK_URL')
ERROR_DISCORD_WEBHOOK_URL = os.getenv('ERROR_DISCORD_WEBHOOK_URL')

def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【WIKI Channel】Error occurred: {error_message}"
    }
    headers = {"Content-Type": "application/json"}
    response = requests.post(ERROR_DISCORD_WEBHOOK_URL, json=error_data, headers=headers)
    if response.status_code != 204:
        print(f"Failed to send error message: {response.status_code}, {response.text}")

try:
    # 日本語WikipediaのURLを設定
    wikipedia.set_lang("ja")

    # ランダムなページを取得
    random_page = wikipedia.random()

    # ページ情報を取得
    page = wikipedia.page(random_page)
    title = page.title
    url = page.url
    summary = page.summary
    
    # embed作成
    embed = {
        "title": title,
        "url": url,
        "description": summary[:2048]  # Discordの制限で説明は2048文字まで
    }
    # Discord用のメッセージを準備

    # Webhookを通じてDiscordにメッセージを送信
    data = {"embeds": [embed]}
    headers = {"Content-Type": "application/json"}
    response = requests.post(WIKI_DISCORD_WEBHOOK_URL, json=data, headers=headers)

    if response.status_code == 204:
        print("Successfully sent message to Discord.")
    else:
        raise Exception(f"Failed to send message: {response.status_code}, {response.text}")

except Exception as error:
    # エラー内容をエラーメッセージ用のDiscord Webhookに送信
    send_error_to_discord(str(error))