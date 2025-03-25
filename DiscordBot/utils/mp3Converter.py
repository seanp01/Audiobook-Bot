import os
import subprocess
import json
import shutil

def extract_chapters(m4b_path):
    """Extracts chapter timestamps from an M4B file using ffmpeg."""
    cmd = [
        "ffprobe", "-i", m4b_path, "-print_format", "json", "-show_chapters"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0 or not result.stdout.strip():
        log_error(f"Failed to extract chapters from {m4b_path}. ffprobe error: {result.stderr}")
        return []  # Return an empty list if ffprobe fails
    
    try:
        chapters = json.loads(result.stdout).get("chapters", [])
    except json.JSONDecodeError as e:
        log_error(f"JSON decoding error for {m4b_path}: {e}")
        return []  # Return an empty list if JSON parsing fails
    
    return [
        {
            "title": chap["tags"].get("title", f"Chapter_{i+1}"),
            "start": float(chap["start_time"]),
            "end": float(chap["end_time"])
        }
        for i, chap in enumerate(chapters)
    ]

def is_file_corrupt(file_path):
    """Checks if a file is corrupt using ffmpeg."""
    cmd = ["ffmpeg", "-v", "error", "-i", file_path, "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    return result.returncode != 0

def log_error(message):
    """Logs an error message to a file."""
    with open("conversion_errors.log", "a") as log_file:
        log_file.write(message + "\n")

def convert_and_split(m4b_path, output_dir):
    """Converts M4B chapters to MP3, skipping valid files and overwriting corrupt ones."""
    os.makedirs(output_dir, exist_ok=True)
    chapters = extract_chapters(m4b_path)
    
    if not chapters:
        log_error(f"No chapters found in {m4b_path}. Skipping file.")
        return  # Skip files without chapters
    
    for i, chapter in enumerate(chapters):
        start_time = chapter["start"]
        end_time = chapter["end"]
        duration = end_time - start_time
        chapter_number = i + 1
        raw_title = f"Chapter_{chapter_number}_{chapter['title'].replace(' ', '_')}"
        sanitized_title = sanitize_filename(raw_title)
        chapter_filename = f"{sanitized_title}.mp3"
        chapter_path = os.path.join(output_dir, chapter_filename)
        
        # Skip if the file exists and is not corrupt
        if os.path.exists(chapter_path) and not is_file_corrupt(chapter_path):
            print(f"Skipping valid file: {chapter_path}")
            continue
        
        # Convert the chapter to MP3
        cmd = [
            "ffmpeg", "-i", m4b_path, "-ss", str(start_time), "-t", str(duration),
            "-acodec", "libmp3lame", "-b:a", "128k", chapter_path
        ]
        try:
            result = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding="utf-8", check=True)
        except subprocess.CalledProcessError as e:
            error_message = f"Error processing chapter {chapter_number}: {e.stderr}"
            print(error_message)
            log_error(error_message)
            continue
        
        # Split large files if necessary
        if os.path.getsize(chapter_path) > 50 * 1024 * 1024:  # Check if size > 50MB
            split_and_save(chapter_path, output_dir)

def restore_original_folder_name(output_dir):
    """Restores the folder name by removing any failure indicators."""
    indicators = [" - failed", " - corrupt", " - incomplete"]
    for indicator in indicators:
        if output_dir.endswith(indicator):
            original_name = output_dir.replace(indicator, "")
            if not os.path.exists(original_name):
                os.rename(output_dir, original_name)
                print(f"Restored folder name: '{output_dir}' -> '{original_name}'")
            return original_name
    return output_dir
            
def sanitize_filename(filename):
    """Sanitizes a filename by removing or replacing invalid characters."""
    invalid_chars = r'<>:"/\|?*'
    sanitized = ''.join(c if c not in invalid_chars else '_' for c in filename)
    if filename != sanitized:
        print(f"Sanitized filename: '{filename}' -> '{sanitized}'")
    return sanitized
            
def split_and_save(file_path, output_dir, max_size_mb=50):
    """Splits an audio file into smaller parts if it exceeds max_size_mb."""
    chunk_length = 5 * 60  # 5 minutes in seconds
    base_filename = os.path.splitext(os.path.basename(file_path))[0]
    
    cmd = [
        "ffmpeg", "-i", file_path, "-f", "segment", "-segment_time", str(chunk_length),
        "-c", "copy", os.path.join(output_dir, f"{base_filename}_part%03d.mp3")
    ]
    subprocess.run(cmd, check=True)
    os.remove(file_path)  # Remove the original large file

def check_for_corruption(output_dir):
    """Checks for corrupt MP3 files in the output directory."""
    corrupt_files = []
    for file in os.listdir(output_dir):
        if file.endswith(".mp3"):
            file_path = os.path.join(output_dir, file)
            if is_file_corrupt(file_path):
                corrupt_files.append(file_path)
    return corrupt_files

def rename_folder(output_dir, suffix):
    """Renames the folder by appending a suffix."""
    new_name = output_dir + f" {suffix}"
    if not os.path.exists(new_name):
        os.rename(output_dir, new_name)

def is_book_complete(output_dir, chapters):
    """Checks if the book is complete by verifying all chapters exist and are not corrupt."""
    if not chapters:
        return False

    # Check if the output directory is empty
    if not os.listdir(output_dir):
        print(f"Output directory is empty: {output_dir}")
        return False

    for i, chapter in enumerate(chapters):
        chapter_number = i + 1
        chapter_filename = f"Chapter_{chapter_number}_{sanitize_filename(chapter['title'].replace(' ', '_'))}.mp3"
        chapter_path = os.path.join(output_dir, chapter_filename)

        # Check if the chapter file exists
        if not os.path.exists(chapter_path):
            print(f"Missing chapter file: {chapter_path}")
            return False

        # Check if the chapter file is corrupt
        if is_file_corrupt(chapter_path):
            print(f"Corrupt chapter file: {chapter_path}")
            return False

    return True

def main(folder, log_file):
    """Main function to process all M4B files in the given folder."""
    processed_files = set()
    
    # Load processed files from log
    if os.path.exists(log_file):
        with open(log_file, 'r') as f:
            processed_files = set(line.strip() for line in f)
    
    for file in os.listdir(folder):
        if file.endswith(".m4b") and file not in processed_files:
            m4b_path = os.path.join(folder, file)
            output_dir = os.path.join(folder, os.path.splitext(file)[0])
            
            # Restore the original folder name if it has an indicator
            output_dir = restore_original_folder_name(output_dir)
            
            try:
                chapters = extract_chapters(m4b_path)
                if os.path.exists(output_dir):
                    # Check if the folder is empty
                    if not os.listdir(output_dir):
                        rename_folder(output_dir, "- failed")
                        continue
                    
                    # Check for corrupt files
                    corrupt_files = check_for_corruption(output_dir)
                    if corrupt_files:
                        rename_folder(output_dir, "- corrupt")
                        continue
                    
                    # Check if the book is complete
                    if is_book_complete(output_dir, chapters):
                        print(f"Book already complete: {file}")
                        continue
                
                # Process the book
                convert_and_split(m4b_path, output_dir)
                
                # Check if the book is complete after processing
                if is_book_complete(output_dir, chapters):
                    print(f"Book successfully processed: {file}")
                    restore_original_folder_name(output_dir)  # Restore folder name
                else:
                    rename_folder(output_dir, "- incomplete")
                
                # Log the processed file
                with open(log_file, 'a') as f:
                    f.write(file + '\n')
            except Exception as e:
                print(f"Error processing {file}: {e}")
                rename_folder(output_dir, "- failed")
            
if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    log_file = os.path.join(script_dir, 'processed_files.log')
    main(script_dir, log_file)