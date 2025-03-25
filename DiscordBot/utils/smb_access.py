import os
import sys
import subprocess

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB

def list_audiobooks():
    try:
        mount_point = '/mnt/windows_share'
        smb_share = '//10.0.0.55/Audiobooks'
        username = 'sean'
        password = ''

        # Ensure the mount point directory exists
        if not os.path.exists(mount_point):
            os.makedirs(mount_point)

        # Unmount if already mounted
        subprocess.run(['sudo', 'umount', mount_point], check=False)

        # Mount the SMB share
        subprocess.run(['sudo', 'mount', '-t', 'cifs', smb_share, mount_point, '-o', f'username={username},password={password},vers=3.0'], check=True, capture_output=True, text=True)

        # List files in the mounted directory
        files = os.listdir(mount_point)
        audiobooks = [file for file in files if file.endswith('.m4b')]

        # Print the list of audiobooks
        for audiobook in audiobooks:
            print(audiobook)

        # Unmount the SMB share
        subprocess.run(['sudo', 'umount', mount_point], check=True, capture_output=True, text=True)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

def get_audiobook(file_name):
    try:
        mount_point = '/mnt/windows_share'
        smb_share = '//10.0.0.55/Audiobooks'
        username = 'sean'
        password = ''

        # Ensure the mount point directory exists
        if not os.path.exists(mount_point):
            os.makedirs(mount_point)

        # Unmount if already mounted
        subprocess.run(['sudo', 'umount', mount_point], check=False)

        # Mount the SMB share
        subprocess.run(['sudo', 'mount', '-t', 'cifs', smb_share, mount_point, '-o', f'username={username},password={password},vers=3.0'], check=True, capture_output=True, text=True)

        # Read the file content
        file_path = os.path.join(mount_point, file_name)
        with open(file_path, 'rb') as file:
            content = file.read()
            sys.stdout.buffer.write(content)

        # Unmount the SMB share
        subprocess.run(['sudo', 'umount', mount_point], check=True, capture_output=True, text=True)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

def get_chapter_times(file_path, chapter_number):
    result = subprocess.run(['ffmpeg', '-i', file_path, '-f', 'ffmetadata', '-'], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error getting chapter times: {result.stderr}", file=sys.stderr)
        return None, None

    lines = result.stdout.splitlines()
    start_time = None
    end_time = None
    chapter_index = -1
    timebase = 1.0

    for line in lines:
        if line.startswith('[CHAPTER]'):
            chapter_index += 1
        if chapter_index == chapter_number:
            if line.startswith('TIMEBASE='):
                timebase_str = line.split('=')[1]
                num, denom = timebase_str.split('/')
                timebase = float(num) / float(denom)
            if line.startswith('START='):
                start_time = float(line.split('=')[1]) * timebase
            if line.startswith('END='):
                end_time = float(line.split('=')[1]) * timebase
                break

    return start_time, end_time

def convert_to_mp3(file_name, output_dir, start_time=0, duration=MAX_FILE_SIZE):
    mount_point = '/mnt/windows_share'
    smb_share = '//10.0.0.55/Audiobooks'
    username = 'sean'
    password = ''
    output_paths = []
    segment_index = 0

    try:
        # Ensure the mount point directory exists
        if not os.path.exists(mount_point):
            os.makedirs(mount_point)

        # Unmount if already mounted
        subprocess.run(['sudo', 'umount', mount_point], check=False, capture_output=True, text=True)

        # Mount the SMB share with read and write permissions
        mount_command = ['sudo', 'mount', '-t', 'cifs', smb_share, mount_point, '-o', f'username={username},password={password},rw,vers=3.0']
        result = subprocess.run(mount_command, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Error mounting SMB share: {result.stderr}", file=sys.stderr)
            return  # Exit the function if mounting fails

        # Convert the .m4b file to .mp3 in 50 MB chunks
        file_path = os.path.join(mount_point, file_name)

        while True:
            output_path = os.path.join(output_dir, f'{os.path.splitext(file_name)[0]}_part{segment_index}.mp3')
            result = subprocess.run(['ffmpeg', '-y', '-i', file_path, '-ss', str(start_time), '-t', str(duration), '-c:a', 'libmp3lame', '-q:a', '2', output_path], capture_output=True, text=True)
            if result.returncode != 0:
                print(f"Error converting audiobook: {result.stderr}", file=sys.stderr)
                break

            if os.path.getsize(output_path) < MAX_FILE_SIZE:
                output_paths.append(output_path)
                break

            output_paths.append(output_path)
            segment_index += 1
            start_time += duration

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

    finally:
        # Unmount the SMB share
        subprocess.run(['sudo', 'umount', mount_point], check=False, capture_output=True, text=True)

        # Return the paths to the generated MP3 files
        for path in output_paths:
            print(path, flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: smb_access.py <list|get|convert|title> [file_name] [start_time] [duration]", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]
    if command == "list":
        list_audiobooks()
    elif command == "get" and len(sys.argv) == 3:
        get_audiobook(sys.argv[2])
    elif command == "convert" and len(sys.argv) >= 3:
        file_name = sys.argv[2]
        start_time = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        duration = int(sys.argv[4]) if len(sys.argv) > 4 else MAX_FILE_SIZE
        convert_to_mp3(file_name, '/tmp/mp3s', start_time, duration)
    else:
        print("Invalid command or missing file_name for 'convert'", file=sys.stderr)
        sys.exit(1)