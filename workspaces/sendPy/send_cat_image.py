import requests
import random
import os

# Discord Webhook URLs
CAT_DISCORD_WEBHOOK_URL = os.getenv('CAT_DISCORD_WEBHOOK_URL')
ERROR_WEBHOOK_URL = os.getenv('ERROR_WEBHOOK_URL')
CAT_API_KEY = os.getenv('CAT_API_KEY')

# フッターのテキスト
cat_footer = 'Image Source: TheCatAPI'
unsplash_footer = 'Image Source: Unsplash'

# ランダムに猫画像 APIかUnsplash APIを選択
api_options = [
    {"name": "cat", "url": 'https://api.thecatapi.com/v1/images/search', "footer": cat_footer},
    {"name": "unsplash", "url": 'https://source.unsplash.com/random?cat', "footer": unsplash_footer}
]
chosen_api = random.choice(api_options)

def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【Cat Channel】Error occurred: {error_message}"
    }
    headers = {"Content-Type": "application/json"}
    response = requests.post(ERROR_WEBHOOK_URL, json=error_data, headers=headers)
    if response.status_code != 204:
        print(f"Failed to send error message: {response.status_code}, {response.text}")

try:
    # 選択したAPIから画像情報を取得
    if chosen_api["name"] == "cat":
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': CAT_API_KEY
        }
        response = requests.get(chosen_api["url"], headers=headers)
        if response.status_code == 200:
            image_url = response.json()[0]['url']
            footer = cat_footer
        else:
            raise Exception(f"Failed to fetch cat image: {response.status_code}, {response.text}")
    else:
        response = requests.get(chosen_api["url"])
        if response.status_code == 200:
            image_url = response.url
            footer = unsplash_footer
        else:
            raise Exception(f"Failed to fetch Unsplash image: {response.status_code}, {response.text}")

    # Discord用のメッセージを準備
    embed = {
        "image": {"url": image_url},
        "footer": {"text": footer}
    }

    # Webhookを通じてDiscordにメッセージを送信
    data = {"embeds": [embed]}
    headers = {"Content-Type": "application/json"}
    response = requests.post(CAT_DISCORD_WEBHOOK_URL, json=data, headers=headers)

    if response.status_code == 204:
        print("Successfully sent message to Discord.")
    else:
        raise Exception(f"Failed to send message: {response.status_code}, {response.text}")

except Exception as error:
    # エラー内容をエラーメッセージ用のDiscord Webhookに送信
    send_error_to_discord(str(error))