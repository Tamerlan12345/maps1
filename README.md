# Insurance Map Application

This is a web application for visualizing insurance contracts on a map of Kazakhstan. It allows users to import contract data from Excel files, filter and view contracts, and see regional seismic risk data.

## Local Development Setup

To run this application on your local machine, follow these steps.

### 1. Prerequisites

-   You need a modern web browser.
-   You need a command-line terminal (like Terminal, Command Prompt, or PowerShell).
-   You need `bash` to run the setup script. Git Bash on Windows is a good option.

### 2. Set Environment Variables

This application requires credentials to connect to a Supabase backend. You must set the following environment variables on your system:

-   `SUPABASE_URL`: The URL of your Supabase project.
-   `SUPABASE_ANON_KEY`: The public (anon) key for your Supabase project.

**How to set variables:**

*   **macOS/Linux:**
    ```bash
    export SUPABASE_URL="your_supabase_url"
    export SUPABASE_ANON_KEY="your_supabase_anon_key"
    ```
    *Note: You may want to add these lines to your `~/.bashrc` or `~/.zshrc` file to make them permanent.*

*   **Windows (Command Prompt):**
    ```cmd
    set SUPABASE_URL="your_supabase_url"
    set SUPABASE_ANON_KEY="your_supabase_anon_key"
    ```

*   **Windows (PowerShell):**
    ```powershell
    $env:SUPABASE_URL="your_supabase_url"
    $env:SUPABASE_ANON_KEY="your_supabase_anon_key"
    ```

### 3. Run the Setup Script

Once the environment variables are set, run the local setup script from your terminal:

```bash
bash setup-local.sh
```

This will create a `config.js` file in the project root, which contains the Supabase credentials the application needs.

### 4. Run the Application

You can run the application in two ways:

1.  **Directly in the Browser:**
    -   Simply open the `index.html` file in your web browser.

2.  **Using a Local Web Server (Recommended):**
    -   If you have Python installed, you can start a simple web server:
        ```bash
        python3 -m http.server 8080
        ```
    -   Then, open `http://localhost:8080` in your browser.

## Deployment

This application is configured for deployment on [Railway](https://railway.app/). The `start.sh` script and `Caddyfile` are used by Railway to build and serve the application. The Supabase credentials must be set as environment variables within the Railway service configuration.
