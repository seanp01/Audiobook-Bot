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



---

## **License**
This project is licensed under the MIT License. See the `LICENSE` file for details.

---
