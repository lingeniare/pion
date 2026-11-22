# Схема обновлений pion (GitHub Releases)

Как устроена раздача релизов: что должен содержать GitHub Release, кто и какие
URL запрашивает, и как опубликовать релиз так, чтобы клиенты увидели
обновление. Реализация живёт в `packages/coding-agent/src/utils/version-check.ts`
(проверка версии), `packages/coding-agent/src/package-manager-cli.ts`
(`pion update`), `install/install.sh` и `install/install.ps1` (инсталлеры).
Ассеты собираются скриптом `scripts/build-vega-release.mjs`.

## Канал раздачи

База: `https://github.com/lingeniare/pion/releases`. GitHub отдаёт файлы
релиза плоским списком по двум адресам:

- `releases/latest/download/<asset>` — файл релиза, помеченного «Latest»
  (самый свежий опубликованный не-draft и не-prerelease);
- `releases/download/<tag>/<asset>` — файл конкретного тега, например
  `releases/download/v1.2.3/pi-coding-agent-1.2.3.tgz`.

Тег обязан называться `v` + версия пакета (`v1.2.3`), потому что managed
обновление строит путь как `download/v{version}/…` — `v` зашита в код
и в инсталлеры.

## Кто какие URL запрашивает

### Автопроверка версии

При интерактивном запуске `pion` делает `GET`:

```
https://github.com/lingeniare/pion/releases/latest/download/installer-release.json
```

Если `version` в ответе новее установленной — показывает баннер «Update
Available» с подсказкой `pion update`, ссылкой на changelog и текстом из поля
`note`. Ошибки сети игнорируются молча (таймаут 10 с). Отключается переменными
`PION_OFFLINE` (все сетевые проверки) и `PION_SKIP_VERSION_CHECK` (только
автопроверка; `pion update` не затрагивается).

### `pion update`

1. Тот же `installer-release.json` (с ретраями, до 2 попыток).
2. Дальше зависит от типа установки:

   - **Managed** (поставлена инсталлером): скачивает
     `releases/download/v{version}/package.json` и `package-lock.json`,
     прогоняет `npm ci` в staging-каталог, проверяет (`pion --version`
     новой сборки) и атомарно активирует релиз. `npm ci` идёт по `resolved`
     из lockfile — внутренние пакеты `@earendil-works/*` указывают на
     `releases/download/v{version}/<pkg>-{version}.tgz` с sha512-integrity.
   - **npm / pnpm / yarn / bun global**: ставится `installSpec` из метаданных
     (по умолчанию — tarball URL релиза). Для npm выводится подсказка
     мигрировать на managed-установку инсталлером.
   - **bun-binary**: автообновления нет, пользователю показывается ссылка
     `https://github.com/lingeniare/pion/releases/latest`.

   Пользовательская команда обновления: `PION_SELF_UPDATE_COMMAND` или
   настройка `selfUpdateCommand` — с плейсхолдерами `{packageName}`,
   `{version}`, `{installSpec}`.

### Инсталлеры (`install.sh`, `install.ps1`)

База — `PION_RELEASES_URL` (дефолт `…/lingeniare/pion/releases`), из неё
выводятся:

| Переменная | Дефолт | Назначение |
| --- | --- | --- |
| `PION_INSTALLER_METADATA_URL` | `…/latest/download/installer-release.json` | метаданные managed-релиза |
| `PION_INSTALLER_DOWNLOAD_BASE` | `…/download` | `…/download/v{version}/{package.json,package-lock.json}` |
| `PION_PACKAGE_SPEC` | `…/latest/download/pi-coding-agent-latest.tgz` | legacy `npm i -g` путь |

Managed-путь в инсталлере повторяет `pion update`: metadata → `v{version}` →
манифесты → `npm ci`. Legacy-путь ставит один tarball
`pi-coding-agent-latest.tgz`; зависимости `@earendil-works/*` внутри него
переписаны на `releases/download/v{version}/…` — npm дотягивает их с релиза.

## Ассеты релиза `vX.Y.Z`

| Файл | Для чего |
| --- | --- |
| `installer-release.json` | метаданные: проверка версии, `pion update`, инсталлеры |
| `package.json` | манифест managed-установки |
| `package-lock.json` | lockfileVersion 3, фиксирует все зависимости и integrity |
| `pi-coding-agent-X.Y.Z.tgz` | основной пакет (installSpec) |
| `<pkg>-X.Y.Z.tgz` × N | каждый внутренний `@earendil-works/*` пакет из install-lock |
| `pi-coding-agent-latest.tgz` | стабильный URL «последней» версии для legacy npm-пути |
| `<pkg>-latest.tgz` × N | симметричные копии всех тарболов |
| `install.sh`, `install.ps1` | инсталлеры под `latest/download/` |

`package.json` и `package-lock.json` — это обработанные копии
`packages/coding-agent/install-lock/`: `resolved` внутренних пакетов ведут на
тарболы этого же тега, `integrity` — sha512 файлов релиза. Поэтому перезаливать
тарболы под тем же тегом нельзя: integrity перестанет сходиться.

## `installer-release.json`

```json
{
  "version": "1.2.3",
  "packageName": "@earendil-works/pi-coding-agent",
  "installSpec": "https://github.com/lingeniare/pion/releases/download/v1.2.3/pi-coding-agent-1.2.3.tgz",
  "note": "Что важно знать про релиз (markdown, показывается в баннере)"
}
```

- `version` — обязательное; должно совпадать с версией пакета и тегом
  `v{version}`: managed-обновление идёт в `download/v{version}/`.
- `packageName`, `installSpec` — необязательные; без них ставится
  `packageName@version` как npm-спек.
- `note` — необязательное; текст баннера обновления.

## Публикация релиза

```bash
npm run build                                                   # нужен dist/
node scripts/build-vega-release.mjs --layout github \
  --repo lingeniare/pion --tag v1.2.3                           # -> .artifacts/github-release/
gh release create v1.2.3 --repo lingeniare/pion --title "v1.2.3" \
  .artifacts/github-release/*                                   # или: gh release upload v1.2.3 …
```

Скрипт пакует все внутренние пакеты из install-lock, переписывает их
зависимости на URL релиза, собирает манифесты с integrity и пишет
`installer-release.json`; в конце — sanity-проверки артефактов.

После `gh release create` GitHub сам помечает релиз «Latest» —
`latest/download/*` начинает отдавать новые файлы, и проверка версии у
клиентов видит обновление. Если «Latest» стоит на старом релизе:
`gh release edit v1.2.3 --repo lingeniare/pion --latest`.

## Правила

- Версия, тег (`v` + версия) и `version` в `installer-release.json` — всегда
  вместе. Несовпадение ломает managed-обновление.
- Prerelease-теги (`-beta.1`) работают, но «Latest» не получат, пока релиз
  помечен prerelease, — автопроверка их не увидит.
- Draft-релизы не раздаются: `latest/download` их не видит. Можно собрать
  релиз черновиком, долить ассеты и только потом опубликовать.
- Ассеты опубликованного релиза неизменяемы — integrity в lockfile посчитан
  по файлам на момент сборки.

## Проверка после публикации

```bash
curl -fsSL https://github.com/lingeniare/pion/releases/latest/download/installer-release.json
curl -fsSL https://github.com/lingeniare/pion/releases/download/v1.2.3/package.json | head
curl -fsIL https://github.com/lingeniare/pion/releases/latest/download/pi-coding-agent-latest.tgz
pion update            # на managed-установке — должен подтянуть новую версию
```

## Переменные окружения

CLI:

- `PION_LATEST_VERSION_URL` — другой endpoint метаданных.
- `PION_INSTALLER_DOWNLOAD_BASE` — другая база `…/v{version}/` манифестов.
- `PION_SELF_UPDATE_COMMAND` — своя команда обновления.
- `PION_OFFLINE`, `PION_SKIP_VERSION_CHECK` — отключение проверок.
- `PION_MANAGED_INSTALL_ROOT` — путь managed-установки.

Инсталлеры:

- `PION_RELEASES_URL` — база, из которой выводятся все URL ниже.
- `PION_INSTALLER_METADATA_URL`, `PION_INSTALLER_DOWNLOAD_BASE`,
  `PION_PACKAGE_SPEC` — точечные переопределения.

## Перенос раздачи на другой хост

Схема хост-независима: зеркало деревa `latest/download/` + `download/v{ver}/`
на любом статическом хосте работает без смены кода. Например, для
`https://vega.codes/pion/release`:

- выложить ассеты как `release/latest/download/<asset>` и
  `release/download/v{ver}/<asset>`;
- инсталлеры запускать с `PION_RELEASES_URL=https://vega.codes/pion/release`;
- на клиентах задать
  `PION_LATEST_VERSION_URL=https://vega.codes/pion/release/latest/download/installer-release.json`
  и `PION_INSTALLER_DOWNLOAD_BASE=https://vega.codes/pion/release/download`
  (или поменять дефолты в `version-check.ts`, `package-manager-cli.ts`,
  `install.sh`, `install.ps1`).
