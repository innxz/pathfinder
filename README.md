# GTA Pathfinder

Микросервис на TypeScript для расчёта **дорожного расстояния** между двумя 3D-точками в GTA V.

Граф дорог строится из дампа [DurtyFree/gta-v-data-dumps](https://github.com/DurtyFree/gta-v-data-dumps) (`nodes.zip`). В рантайме — **0 production-зависимостей**, поиск маршрута через multi-anchor A*.

## Зачем это нужно

Это не «ещё один A*», а **серверный сервис дорожной дистанции для GTA V** — в первую очередь для RAGE MP / FiveM и RP-серверов.

Нативный `calculateTravelDistanceBetweenPoints` живёт в игровом процессе: его неудобно вызывать массово с бэкенда, централизованно кэшировать или использовать в Docker без online-игрока. Pathfinder даёт **один HTTP-контракт** для всех систем сервера: такси, доставка, квесты, античит, UI.

**Две разные метрики в одном ответе:**

| Метрика | Для чего |
|---|---|
| `straightDistance` | Прямая 3D-дистанция — как «Точка маршрута (4181m)» на карте GTA в паузе |
| `distance` | Длина маршрута **по дорогам** — для тарифов, таймеров, «сколько ехать» |

**Где проект полезен:**

- серверная логика без клиента GTA (биллинг, матчмейкинг, валидация перемещений);
- единая «истина» для расстояний на кастомном сервере;
- быстрый расчёт с LRU-кэшем и предсказуемой latency.

**Честные ограничения:**

- это **не 100% замена** нативного GPS — по дорогам типичная погрешность **~5–7%** (см. [Точность](#точность));
- потолок точности — **данные** (`nodes.json`), а не алгоритм; для <3% нужны **ynd** из CodeWalker;

## Архитектура

```
nodes.zip → scripts/build-graph.ts → data/graph.bin (~2.7 MB)
                                      ↓
                              RoadGraph + A*
                                      ↓
                              HTTP API (dist/index.js)
```

При сборке Docker-образа `nodes.zip` скачивается автоматически, граф собирается внутри контейнера.

## Быстрый старт (Docker)

```bash
docker compose up --build -d
curl http://localhost:3005/health
```

Сервис слушает **3005** на хосте (внутри контейнера — 3000).

## Локальная разработка

```bash
npm install

# Скачать nodes.zip в корень проекта, затем:
npm run build:graph -- nodes.zip data/graph.bin
npm run build
npm start
# или
npm run dev
```

## API

### `GET /health`

Проверка состояния и статистика графа.

```json
{
  "status": "ok",
  "nodes": 67454,
  "edges": 180176,
  "cells": 513,
  "graphVersion": 2,
  "cacheSize": 0,
  "cacheCapacity": 10000
}
```

### `GET /distance`

Query-параметры:

| Параметр | Описание |
|---|---|
| `fromX`, `fromY`, `fromZ` | Начальная точка |
| `toX`, `toY`, `toZ` | Конечная точка |
| `path=1` | Включить полилинию маршрута |

Пример:

```bash
curl "http://localhost:3005/distance?fromX=215&fromY=-890&fromZ=30&toX=120&toY=-1800&toZ=30"
```

### `POST /distance`

```bash
curl -s -X POST http://localhost:3005/distance \
  -H 'Content-Type: application/json' \
  -d '{
    "from": {"x": 215, "y": -890, "z": 30},
    "to":   {"x": 120, "y": -1800, "z": 30},
    "includePath": true
  }'
```

### Ответ

```json
{
  "distance": 5669.42,
  "straightDistance": 4182.39,
  "fromNode": 34132,
  "toNode": 54175,
  "pathNodes": 142,
  "computeMs": 12.345,
  "cached": false,
  "path": [{"x": 215, "y": -890, "z": 30}, ...]
}
```

| Поле | Значение |
|---|---|
| `distance` | Длина маршрута **по дорогам** (метры) |
| `straightDistance` | Прямая 3D-дистанция между точками (метры) |
| `fromNode`, `toNode` | ID ближайших узлов графа |
| `pathNodes` | Количество узлов в маршруте |
| `path` | Полилиния (если запрошена): `[from, ...nodes..., to]` |
| `cached` | Результат взят из LRU-кэша |
| `computeMs` | Время расчёта (мс) |

### Ошибки

- `400` — неверные координаты или JSON
- `404` — маршрут не найден (`{"error": "No route found between the points"}`)
- `405` — неподдерживаемый HTTP-метод

## Точность

На примере маршрута Los Santos → Sandy Shores:

| Источник | Значение | Что измеряет |
|---|---|---|
| Карта GTA («Точка маршрута») | ~4181 m | **Прямая** до waypoint, не длина GPS-линии |
| `straightDistance` | ~4182 m | То же самое ✓ |
| GTA native (`calculateTravelDistanceBetweenPoints`) | ~5295 m | По дорогам |
| Этот сервис | ~5669 m | По дорогам (~+7%) |

**Прямая дистанция** считается корректно. Расхождение ~5–7% — только в **дорожном** маршруте: JSON-дамп `nodes.json` — упрощённое представление навигационного графа GTA. Для точности <3% нужны бинарные **ynd**-файлы (CodeWalker), а не JSON.

Для многих серверных сценариев (тариф такси ±10%, «квест не короче N км по дорогам») текущей точности **достаточно**. Для побития native GPS один в один — без ynd не обойтись.

## Переменные окружения

### Сервис

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `GRAPH_PATH` | `data/graph.bin` | Путь к бинарному графу |
| `CACHE_SIZE` | `10000` | Ёмкость LRU-кэша маршрутов |

### Сборка графа (`npm run build:graph`)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BRIDGE_MAX_DIST` | `30` | Мосты для тупиков (м) |
| `GAP_BRIDGE_MAX_DIST` | `15` | Мосты между близкими разрывами (м) |
| `GAP_BRIDGE_MAX_DEGREE` | `2` | Макс. степень узла для gap-мостов |

Пример:

```bash
BRIDGE_MAX_DIST=40 GAP_BRIDGE_MAX_DIST=20 npm run build:graph -- nodes.zip data/graph.bin
```

## Сравнение с GTA (RAGE MP)

В `tools/ragemp-compare/` — клиент и серверный пакет для сравнения с нативным GPS GTA.

**Установка:**

1. Скопировать `tools/ragemp-compare/packages/pathfinder-compare/` → `<server>/packages/pathfinder-compare/`
2. Скопировать `tools/ragemp-compare/client_packages/pathfinder-compare/` → `<server>/client_packages/pathfinder-compare/`
3. Подключить в `packages/index.js` и `client_packages/index.js`
4. Задать `PATHFINDER_URL=http://127.0.0.1:3005/distance` (сервер должен достучаться до pathfinder)

**Команды в игре:**

| Команда | Описание |
|---|---|
| `/pfcoords` | Координаты игрока и waypoint |
| `/pfcompare` | Сравнение GTA native vs сервис |
| `/pfshow` | Отрисовка маршрута сервиса (красная линия) |
| `/pfhide` | Скрыть линию |

## Структура проекта

```
src/
  index.ts       — HTTP-сервер
  graph.ts       — загрузка graph.bin, spatial lookup
  pathfinder.ts  — multi-source/multi-target A*
  cache.ts       — LRU-кэш по координатам (округление 0.1 m)
  types.ts       — типы и константы графа
scripts/
  build-graph.ts — препроцессор nodes.json → graph.bin
tools/
  compare.sh     — CLI-тест API
  ragemp-compare/ — интеграция с RAGE MP
```

## Алгоритм

1. Точки «привязываются» к нескольким ближайшим узлам графа (multi-anchor snap).
2. A* ищет кратчайший путь между комбинациями start/end узлов.
3. Веса рёбер — 2D-расстояние `hypot(dx, dy)` (как у GTA GPS).
4. При сборке графа добавляются мосты для тупиков и мелких разрывов в дампе.
