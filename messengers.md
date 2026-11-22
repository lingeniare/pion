# Управление pion из мессенджера

pion не поставляется с привязкой к мессенджерам — подключение опционально и ставится самим пользователем. Ниже — три рабочих варианта и замечания по доступности из России.

## Что выбрать

| Вариант | Тип | Что даёт | Когда брать |
|---|---|---|---|
| [pi-courier](https://pi.dev/packages/pi-courier) | отдельный сервис | Matrix-бот гоняет свои сессии pion по RPC: слэш-команды, скиллы, шаблоны — всё как в терминале | Основной вариант: always-on мост, работает без открытого терминала, Matrix пока доступен в РФ |
| [@comput/pi-telegram](https://pi.dev/packages/@comput/pi-telegram) | расширение | Привязывает Telegram-бота к вашей живой интерактивной сессии — тот же контекст проекта, те же файлы | Удобно «отойти от компа и продолжить»; требует доступный `api.telegram.org` |
| [pi-messenger-bridge](https://pi.dev/packages/pi-messenger-bridge) | расширение | Один мост на Telegram / WhatsApp / Slack / Discord / Matrix | Если нужен не-Matrix транспорт — но из списка в РФ реален только Matrix |

Варианты совместимы: например, pi-courier как постоянный мост и pi-telegram как фронтенд к интерактивной сессии.

## pi-courier (Matrix) — рекомендуемый

Схема: `Matrix-клиент на телефоне → homeserver → pi-courier → pion --mode rpc`. Каждое сообщение боту — ход агента; сессии переживают рестарты.

**Нужно заранее:** Matrix-аккаунт для бота (отдельный, не ваш личный) на `matrix.org` или своём homeserver, плюс Matrix-клиент на телефоне (Element X, FluffyChat).

Установка — только глобально, это standalone-сервис (не `pion install` — тот поставит лишь подсказку-расширение):

```bash
npm install -g pi-courier
pi-courier setup     # мастер: homeserver, логин/пароль бота, ваш Matrix ID как trusted user, workdir
pi-courier run       # запуск в фореграунде
pi-courier enable    # автозапуск: systemd на Linux, Планировщик задач на Windows
pi-courier doctor    # диагностика (--fix исправляет, --json машиночитаемо)
```

Особенности:

- **npm ≥ 11 может молча пропустить postinstall** (gate `install-scripts`), и тогда не скачается нативная библиотека E2EE. Признак — warning `install-scripts` при установке. Разовое решение:
  `npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier`
  либо вручную `node <глобальный npm root>/pi-courier/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.
- **Указать pion вместо pi.** Pi-courier сам ищет бинарник `pi` и managed-установку в `~/.pi`. Для pion пропишите путь явно — поле `cliPath` в конфиге (`~/.config/pi-courier/pi-courier.json` на Linux/macOS, `%USERPROFILE%\.pi\pi-courier.json` на Windows) или переменная `PI_CLI_PATH`. Значение — путь к `dist/bundle/cli.js` установленного pion, при managed-установке это
  `~/.pion/agent/install/releases/<версия>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
- **Прокси.** Если машине нужен прокси для выхода наружу — поле `proxy` в том же конфиге (только `http://`/`https://`) покрывает и Matrix-трафик, и запросы pion к провайдеру (env инжектируется в дочерний процесс).
- **Рабочие проекты.** Мост смотрит в настроенный workdir (по умолчанию `~/Projects`) — кладите туда репозитории, которыми управляете с телефона.

## @comput/pi-telegram — фронтенд к живой сессии

Расширение ставится в pion и привязывает вашего Telegram-бота к одной persistent-сессии:

```bash
pion install npm:@comput/pi-telegram
```

Дальше внутри pion: `/telegram-start` → **Add a bot** → **Add BotFather bot** → username и токен (ввод маскируется). В Telegram откройте чат с ботом, нажмите Start и отправьте одноразовый код привязки (живёт 3 минуты). Проверка: `/telegram-status` в pion, `/ping` в чате бота.

Особенности:

- Бот создаётся у [@BotFather](https://t.me/BotFather) командой `/newbot` — токен нельзя вставлять в диалог с агентом или в чаты.
- Бот привязан к **одной сессии**, а не к папке проекта: после перезапуска вернитесь в неё через `pion -r`, бот переподключится сам. Новая сессия бота не наследует.
- `api.telegram.org` должен быть достижим с машины, где крутится pion. В РФ это не гарантировано — при недоступности нужен прокси/VPN на той машине, либо берите pi-courier.
- **Чаты Telegram-ботов не E2EE** — трафик идёт через серверы Telegram. Не пересылайте через бота секреты.

## pi-messenger-bridge — мультитранспорт

```bash
pion install npm:pi-messenger-bridge
```

Управление изнутри: `/msg-bridge` → configure. Для Matrix: `/msg-bridge configure matrix <homeserver-url> <access-token>`, далее `/msg-bridge connect`. Первое сообщение боту от нового пользователя возвращает 6-значный challenge — код показывается в терминале pion, его ввод делает пользователя trusted.

## Безопасность

Мост — это удалённый терминал к агенту, который исполняет команды на вашей машине. Относитесь к нему как к SSH-доступу:

- Trusted-список — только свои аккаунты; pairing/challenge-коды никому не пересылайте и не публикуйте.
- В Matrix держите E2EE включённым и один раз верифицируйте устройство бота — иначе шифрованные комнаты не расшифруются.
- Токены ботов и access-токены хранятся на машине с pion; кто читает `~/.pion/agent` и конфиг pi-courier — тот управляет ботом.
- Запускайте мост в проекте, которому доверяете: у агента остаются его обычные права на файлы и команды.

## Если matrix.org станет недоступен

Публичные homeserver'ы — точка блокировки. Свой homeserver (Dendrite, conduwuit) на VPS даёт трафик HTTPS/443 на ваш домен — такие единичные endpoint'ы под радаром массовых блокировок. Запасные каналы без своего клиента: [Delta Chat](https://delta.chat) (мессенджер поверх email, есть Android-приложение) и self-hosted [ntfy](https://ntfy.sh) (publish/subscribe по HTTP, своё Android-приложение).
