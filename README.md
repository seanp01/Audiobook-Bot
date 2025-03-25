---

# **MultiMediaOnDemand**

### **Author:** Sean Parker

---

## **Overview**
The `MultiMediaOnDemand` project is a comprehensive system designed to integrate various multimedia services, including Discord-based playback, DVR catalog management, live streaming, and remote control APIs. This project aims to provide a seamless and user-friendly experience for managing and consuming multimedia content.

---

## **Project Components**
The repository consists of the following key services and modules:

### **1. DiscordBot**
- A bot system for Discord that supports:
  - **Master Bot**: Manages interactions and delegates playback tasks to minion bots.
  - **Minion Bots**: Handle individual playback instances for users in separate Discord channels.
- Features:
  - Audiobook playback with chapter and timestamp tracking.
  - Playback controls (play, pause, skip, rewind, etc.).
  - Dynamic UI updates in Discord chat (e.g., seek bars, playback state).
  - Multi-user support with isolated playback sessions.
  - Integration with SMB shares for accessing media files.

---

### **2. DVRService**
- A service for managing DVR content, including:
  - Cataloging recorded content.
  - Providing APIs for querying and accessing DVR recordings.
  - Supporting content acquisition requests and queues.

---

### **3. LiveOnDemandService**
- A service for managing live streams, including:
  - Starting and stopping live streams.
  - Providing APIs for accessing live content.
  - Integration with Discord for live stream playback.

---

### **4. PlaybackService**
- Handles playback-related tasks, including:
  - Audio file manipulation and conversion (e.g., MP3 generation).
  - Integration with FFmpeg for efficient media processing.
  - Caching and optimizing playback data for multiple users.

---

### **5. PiService**
- A lightweight service designed for Raspberry Pi devices.
- Features:
  - Simple command-switch scripts for controlling playback and live streams.
  - Integration with the PlaybackAPI for remote control.

---

### **6. PlaybackAPI**
- Provides APIs for controlling playback, including:
  - Starting, stopping, and seeking within media files.
  - Managing user preferences and playback queues.

---

### **7. RemoteControlAPI**
- A RESTful API for remote control functionality, including:
  - Managing DVR content.
  - Controlling live streams and playback sessions.
  - Handling user preferences and content acquisition requests.

---

## **Features**
- **Multi-User Playback:**
  - Supports multiple users with isolated playback sessions.
  - Each user can control their own playback without interfering with others.

- **Discord Integration:**
  - Playback controls and updates directly in Discord chat.
  - Dynamic UI elements like seek bars and playback state indicators.

- **Media Processing:**
  - Efficient audio processing using FFmpeg.
  - Support for SMB shares to access media files across platforms.

- **Cross-Platform Support:**
  - Designed to run on both Windows and Linux (including Raspberry Pi).

- **Scalability:**
  - Modular architecture allows for easy addition of new minion bots and services.


---

## **License**
This project is licensed under the MIT License. See the `LICENSE` file for details.

---
