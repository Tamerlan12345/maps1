// 1. Переименуйте этот файл в config.js
// 2. Вставьте ваш Supabase URL и публичный ключ (anon key).
// ВАЖНО: Убедитесь, что файл config.js добавлен в .gitignore и не попадет в систему контроля версий.

// Этот объект будет использоваться в app.js для инициализации клиента Supabase.
// Структура этого объекта должна соответствовать тому, что генерируется в start.sh для продакшн-среды.
window.SUPABASE_CONFIG = {
  supabaseUrl: 'YOUR_SUPABASE_URL',       // Замените на ваш URL
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY', // Замените на ваш публичный ключ (anon)
};