import random
import os

import requests
from discord_http_client import post_discord_or_throw

# Discord Webhook URLs
CAT_DISCORD_WEBHOOK_URL = os.getenv('CAT_DISCORD_WEBHOOK_URL')
ERROR_WEBHOOK_URL = os.getenv('ERROR_WEBHOOK_URL')
CAT_API_KEY = os.getenv('CAT_API_KEY')
PIXABAY_API_KEY = os.getenv('PIXABAY_API_KEY')
FLICKR_API_KEY = os.getenv('FLICKR_API_KEY')

# フッターのテキスト
cat_footer = 'Image Source: TheCatAPI'
unsplash_footer = 'Image Source: Unsplash'
pixabay_footer = 'Image Source: Pixabay'
flickr_footer = 'Image Source: Flickr'

# API options
api_options = [
    {"name": "cat", "url": 'https://api.thecatapi.com/v1/images/search', "footer": cat_footer},
    {"name": "unsplash", "url": 'https://source.unsplash.com/random?cat', "footer": unsplash_footer},
    {"name": "pixabay", "url": 'https://pixabay.com/api/', "footer": pixabay_footer},
    {"name": "flickr", "url": 'https://api.flickr.com/services/rest/', "footer": flickr_footer}
]

def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【Cat Channel】Error occurred: {error_message[:1900]}"
    }
    try:
        post_discord_or_throw(ERROR_WEBHOOK_URL, error_data)
    except Exception as e:
        print(f"Failed to send error to Discord: {e}")

def get_image_url(api_option):
    try:
        if api_option["name"] == "cat":
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': CAT_API_KEY
            }
            response = requests.get(api_option["url"], headers=headers)
            if response.status_code == 200:
                image_url = response.json()[0]['url']
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch cat image: {response.status_code}")

        elif api_option["name"] == "unsplash":
            response = requests.get(api_option["url"])
            if response.status_code == 200:
                image_url = response.url
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Unsplash image: {response.status_code}")

        elif api_option["name"] == "pixabay":
            page = random.randint(1, 200)
            response = requests.get(api_option["url"], params={
                "key": PIXABAY_API_KEY,
                "q": "cat",
                "image_type": "photo",
                "per_page": 3,
                "page": page
            })
            if response.status_code == 200:
                data = response.json()
                hits = data.get('hits', [])
                if not hits:
                    return None, "No Pixabay images found"
                image_url = random.choice(hits)['webformatURL']
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Pixabay image: {response.status_code}")

        elif api_option["name"] == "flickr":
            page = random.randint(1, 1000)
            response = requests.get(api_option["url"], params={
                "method": "flickr.photos.search",
                "api_key": FLICKR_API_KEY,
                "tags": "cat",
                "per_page": 1,
                "page": page,
                "format": "json",
                "nojsoncallback": 1
            })
            if response.status_code == 200:
                photos = response.json().get('photos', {}).get('photo', [])
                if not photos:
                    return None, "No Flickr images found"
                photo = random.choice(photos)
                image_url = f"https://live.staticflickr.com/{photo['server']}/{photo['id']}_{photo['secret']}.jpg"
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Flickr image: {response.status_code}")

        return image_url, footer
    except Exception as error:
        return None, str(error)

def fetch_image_and_send_to_discord(api_options):
    remaining = list(api_options)

    while remaining:
        source = random.choice(remaining)
        source_name = source['name']
        print(f"Fetching image from {source_name}...")
        image_url, footer_or_error = get_image_url(source)
        if image_url:
            embed = {
                "image": {"url": image_url},
                "footer": {"text": footer_or_error}
            }
            data = {"embeds": [embed]}
            post_discord_or_throw(CAT_DISCORD_WEBHOOK_URL, data)
            print("Successfully sent message to Discord.")
            return
        remaining.remove(source)

    send_error_to_discord("No API options available to fetch images.")

fetch_image_and_send_to_discord(api_options)
