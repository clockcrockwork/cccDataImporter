import requests
import random
import os

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
    {"name": "cat", "url": 'https://api.thecatapi.com/v1/images/search', "footer": cat_footer, "key": CAT_API_KEY},
    {"name": "unsplash", "url": 'https://source.unsplash.com/random?cat', "footer": unsplash_footer},
    {"name": "pixabay", "url": f'https://pixabay.com/api/?key={PIXABAY_API_KEY}&q=cat&image_type=photo&per_page=3&page=', "footer": pixabay_footer},
    {"name": "flickr", "url": f'https://api.flickr.com/services/rest/?method=flickr.photos.search&api_key={FLICKR_API_KEY}&tags=cat&per_page=1&page=', "footer": flickr_footer}
]

def send_error_to_discord(error_message: str):
    error_data = {
        "content": f"【Cat Channel】Error occurred: {error_message}"
    }
    headers = {"Content-Type": "application/json"}
    response = requests.post(ERROR_WEBHOOK_URL, json=error_data, headers=headers)
    if response.status_code != 204:
        print(f"Failed to send error message: {response.status_code}, {response.text}")

def get_image_url(api_option):
    try:
        if api_option["name"] == "cat":
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': api_option["key"]
            }
            response = requests.get(api_option["url"], headers=headers)
            if response.status_code == 200:
                image_url = response.json()[0]['url']
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch cat image: {response.status_code}, {response.text}")

        elif api_option["name"] == "unsplash":
            response = requests.get(api_option["url"])
            if response.status_code == 200:
                image_url = response.url
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Unsplash image: {response.status_code}, {response.text}")

        elif api_option["name"] == "pixabay":
            page = random.randint(1, 1000)
            response = requests.get(api_option["url"] + str(page))
            if response.status_code == 200:
                image_url = random.choice(response.json()['hits'])['webformatURL']
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Pixabay image: {response.status_code}, {response.text}")

        elif api_option["name"] == "flickr":
            page = random.randint(1, 1000)
            response = requests.get(api_option["url"] + str(page) + "&format=json&nojsoncallback=1")
            if response.status_code == 200:
                photo = random.choice(response.json()['photos']['photo'])
                image_url = f"https://live.staticflickr.com/{photo['server']}/{photo['id']}_{photo['secret']}.jpg"
                footer = api_option["footer"]
            else:
                raise Exception(f"Failed to fetch Flickr image: {response.status_code}, {response.text}")

        return image_url, footer
    except Exception as error:
        return None, str(error)

def fetch_image_and_send_to_discord(api_options):
    if not api_options:
        send_error_to_discord("No API options available to fetch images.")
        return

    source = random.choice(api_options)
    print(f"Fetching image from {source['name']}...")
    image_url, footer_or_error = get_image_url(source)
    if image_url:
        embed = {
            "image": {"url": image_url},
            "footer": {"text": footer_or_error}
        }
        data = {"embeds": [embed]}
        headers = {"Content-Type": "application/json"}
        response = requests.post(CAT_DISCORD_WEBHOOK_URL, json=data, headers=headers)
        if response.status_code == 204:
            print("Successfully sent message to Discord.")
        else:
            send_error_to_discord(f"Failed to send message: {response.status_code}, {response.text}")
    else:
        api_options.remove(source)
        fetch_image_and_send_to_discord(api_options)

fetch_image_and_send_to_discord(api_options)