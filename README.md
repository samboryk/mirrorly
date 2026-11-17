# Mirrorly

Повтор екрана iPhone та iPad на Windows 11. Mirrorly перетворює комп’ютер на приймач AirPlay: на iPhone відкрийте **Пункт керування → Повтор екрана** й оберіть свій ПК.

## Завантаження

Остання версія — на сторінці [Releases](https://github.com/samboryk/mirrorly/releases/latest). Завантажте `Mirrorly-Setup-x.y.z.exe` і встановіть. Після цього програма оновлюється сама.

Вимоги: Windows 10/11 x64, iPhone і ПК в одній мережі Wi‑Fi.

## Можливості

- Повтор екрана H.264 до 1440p і 60 к/с, зі звуком (AAC‑ELD)
- Запит дозволу для нових пристроїв і список довірених
- Знімки екрана, режим «поверх вікон», повноекранний режим
- Автоматичні оновлення з перевіркою SHA‑256

## Збірка

```bash
cd app && npm install            # залежності програми
cd ../build && npm install && node build.js
makensis -DVERSION=1.1.2 -DINSTALLED_KB=$(du -sk dist/Mirrorly | cut -f1) installer.nsi
```

`build.js` очікує Electron для Windows x64 у `ELECTRON_ZIP` (за замовчуванням `/tmp/electron-win.zip`).

## Випуск оновлення

1. Збільшіть `version` в `app/package.json` і зберіть інсталятор.
2. Створіть реліз з тегом `vX.Y.Z` і прикріпіть `Mirrorly-Setup-X.Y.Z.exe`.
   Встановлені копії знайдуть його самі.

## Ліцензія

GPL‑3.0. Використано алгоритм FairPlay «playfair» з проєктів UxPlay/shairplay (GPL‑3.0), Fraunhofer FDK AAC, Electron і шрифт Inter (SIL OFL 1.1).
AirPlay та iPhone є торговими марками Apple Inc.; Mirrorly не пов’язана з Apple.
