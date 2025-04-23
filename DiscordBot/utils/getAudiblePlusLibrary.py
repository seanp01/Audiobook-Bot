import requests
import time
from datetime import datetime
import json

session_token = "PASTE_SESSION_TOKEN"  # Replace with your session token

headers = {
    "Cookie": f"session-token={session_token}",
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json"
}

base_params = {
    "response_groups": "product_desc,product_attrs,product_plans",
    "num_results": 50,
    "products_sort_by": "BestSellers",
    "content_delivery_types": "Stream",
    "page": 1,
    "keywords": "included in audible plus"
}

url = "https://api.audible.com/1.0/catalog/products"

page = 1
seen_products = set()
seen_titles = set()
results = []
duplicate_found = False  # Flag to indicate when a duplicate is found

while not duplicate_found:
    params = {**base_params, "page": page}
    response = requests.get(url, headers=headers, params=params)

    if response.status_code != 200:
        break

    data = response.json()
    products = data.get("products", [])

    if not products:
        break

    for product in products:
        asin = product.get("asin")
        title = product.get("title") or product.get("publication_name", "Unknown Title")
        if asin in seen_products:
            duplicate_found = True
            break
        if title in seen_titles:
            break

        seen_products.add(asin)
        seen_titles.add(title)

        plans = product.get("plans", [])
        title = product.get("title") or product.get("publication_name", "Unknown Title")
        authors = [author.get("name", "Unknown Author") for author in product.get("authors", [])]  # Extract author names
        runtime = product.get("runtime_length_min", "Unknown Runtime")
        release_date = product.get("release_date", "Unknown Release Date")
        language = product.get("language", "Unknown Language")
        delivery = product.get("content_delivery_type", "Unknown")
        codecs = [c.get("name", "Unknown Codec") for c in product.get("available_codecs", [])]
        cover_image = (product.get("images", {}) or product.get("product_images", {})).get("primary", {}).get("url", "No Image Available")
        genres = product.get("genres", ["Unknown Genre"])  # Extract genres

        minerva_plan = next((plan for plan in plans if plan.get("plan_name") == "US Minerva"), None)
        if minerva_plan:
            end_date = minerva_plan.get("end_date")
            if end_date:
                end_date_obj = datetime.strptime(end_date, "%Y-%m-%dT%H:%M:%S.%fZ")
                days_left = (end_date_obj - datetime.utcnow()).days

                results.append({
                    "title": title,
                    "authors": authors,
                    "runtime": runtime,
                    "release_date": release_date,
                    "language": language,
                    "delivery": delivery,
                    "codecs": codecs,
                    "cover_image": cover_image,
                    "genres": genres,
                    "end_date": end_date_obj.strftime("%Y-%m-%d"),
                    "days_left": days_left
                })
                
        if not duplicate_found:
            page += 1
            time.sleep(0.5)

def fetch_book_details(asin):
    """Fetch detailed information for a specific book using its ASIN."""
    url = f"https://api.audible.com/1.0/catalog/products/{asin}"
    params = {
        "response_groups": "product_desc,product_attrs,product_plans,media",
    }
    response = requests.get(url, headers=headers, params=params)

    if response.status_code == 200:
        product = response.json().get("product", {})
        plans = product.get("plans", [])
        minerva_plan = next((plan for plan in plans if plan.get("plan_name") == "US Minerva"), None)
        if minerva_plan:
            end_date = minerva_plan.get("end_date")
            if end_date:
                end_date_obj = datetime.strptime(end_date, "%Y-%m-%dT%H:%M:%S.%fZ")
                days_left = (end_date_obj - datetime.utcnow()).days

                return {
                    "title": product.get("title", "Unknown Title"),
                    "authors": product.get("authors")[0].get("name", "Unknown Author"),
                    "cover_image": product.get("product_images", {}).get("500", "No Image Available"),
                    "runtime": product.get("runtime_length_min", "Unknown Runtime"),
                    "release_date": product.get("release_date", "Unknown Release Date"),
                    "genres": product.get("thesaurus_subject_keywords", ["Unknown Genre"]),
                    "days_left": days_left,
                }
    else:
        print(f"Failed to fetch details for ASIN {asin}: {response.status_code}")
        return None

detailed_books = []

for asin in seen_products:
    book_details = fetch_book_details(asin)
    if book_details and not any(('bdsm' in genre.lower() or 'la_confidential' in genre.lower() or 'tandem' in genre.lower()) for genre in book_details['genres']):
        detailed_books.append(book_details)

# Print the detailed books
print(json.dumps(detailed_books, indent=2))