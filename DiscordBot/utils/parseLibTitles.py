import os
import mutagen
from mutagen.mp4 import MP4

def get_m4b_metadata(file_path):
    """Extract title and author from an m4b file."""
    try:
        audio = MP4(file_path)
        title = audio.tags.get("\xa9nam", ["Unknown Title"])[0]
        author = audio.tags.get("\xa9ART", ["Unknown Author"])[0]
        return title, author
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return None, None

def organize_audiobooks(folder_path):
    """Group audiobooks by author and print formatted output."""
    audiobooks = {}

    for file in os.listdir(folder_path):
        if file.endswith(".m4b"):
            file_path = os.path.join(folder_path, file)
            title, author = get_m4b_metadata(file_path)

            if author not in audiobooks:
                audiobooks[author] = []
            audiobooks[author].append(title)

    # Print the organized output
    for author, titles in sorted(audiobooks.items()):
        print(f"\n{author}")
        for title in sorted(titles):
            print(f"  - {title}")

# Set your target folder
folder_path = "\\\\DESKTOP-JVHG3GN\\Audiobooks2"
organize_audiobooks(folder_path)
