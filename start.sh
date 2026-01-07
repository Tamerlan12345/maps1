#!/bin/bash

# Этот скрипт выполняется Railway для запуска приложения.
# Сначала он создает config.js, а затем запускает Caddy с Caddyfile.

echo "Generating config.js from environment variables..."

# Создаем config.js
cat <<EOF > config.js
window.SUPABASE_CONFIG = {
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}",
};
EOF

echo "config.js generated successfully."

# ИЗМЕНЕНИЕ:
# Запускаем Caddy с помощью 'caddy run',
# который автоматически найдет и использует Caddyfile
echo "Starting Caddy server with Caddyfile..."
caddy run
