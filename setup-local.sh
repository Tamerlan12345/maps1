#!/bin/bash

# Этот скрипт генерирует config.js для локальной разработки,
# используя переменные из .env файла.

# 1. Проверить, существует ли .env файл
if [ ! -f .env ]; then
  echo "Файл .env не найден."
  # Проверить, существует ли .env.example
  if [ -f .env.example ]; then
    echo "Копирую .env.example в .env..."
    cp .env.example .env
    echo "Файл .env создан. Пожалуйста, заполните его вашими учетными данными Supabase и запустите скрипт снова."
  else
    echo "Файл .env.example также не найден. Пожалуйста, создайте .env файл вручную."
  fi
  exit 1
fi

# 2. Загрузить переменные из .env файла
echo "Загрузка переменных из .env..."
# 'set -a' экспортирует все переменные, которые мы создаем или изменяем
# 'set +a' отключает это поведение
set -a
source .env
set +a

# 3. Проверить, что переменные установлены
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ] || [ "$SUPABASE_URL" == "YOUR_SUPABASE_URL" ]; then
  echo "Ошибка: Переменные SUPABASE_URL и SUPABASE_ANON_KEY должны быть установлены в .env файле."
  echo "Пожалуйста, убедитесь, что вы заполнили .env файл корректными значениями."
  exit 1
fi

# 4. Сгенерировать config.js
echo "Генерация config.js из переменных .env..."

cat <<EOF > config.js
window.SUPABASE_CONFIG = {
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}",
};
EOF

echo "config.js успешно сгенерирован."
echo "Теперь вы можете открыть index.html в вашем браузере."

# Сделать скрипт исполняемым (на всякий случай)
chmod +x ./setup-local.sh
