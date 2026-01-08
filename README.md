# Centras-Maps

This is a web application for visualizing data on a map of Kazakhstan. It displays regions, seismic risk data, and weather information.

## Local Development Setup

To run this application on your local machine, follow these steps.

### 1. Prerequisites

-   You need a modern web browser.
-   You need a local web server (e.g., Python `http.server`, Caddy, or Live Server extension for VS Code).

### 2. Run the Application

You can run the application using a local web server:

**Using Python:**
If you have Python installed, you can start a simple web server:
```bash
python3 -m http.server 8080
```
Then, open `http://localhost:8080` in your browser.

**Using Caddy:**
If you have Caddy installed:
```bash
caddy run
```
Then, open `http://localhost:8080` (or the port specified/defaulted).

## Deployment

This application is configured for deployment as a static site. The `Caddyfile` is included for serving with Caddy.
