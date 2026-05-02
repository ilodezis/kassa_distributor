[🇬🇧 English version](#english-version) | [🇷🇺 Русская версия](#русская-версия)

---

### <a name="english-version"></a> 🇬🇧 English version

# Kassa Distribution Tool 📊

A desktop application for intelligent workload balancing of a client pool (cash registers/deals) across support managers. This project automates the distribution process, eliminates manual overhead, and minimizes client migration using a cost-based optimization model.

## 💡 Architecture & Stack
* **Language:** Python 3.10+
* **Data Processing:** `pandas` (vectorized data processing, groupings).
* **GUI:** `tkinter` + `ttk` (`clam` theme for a clean interface).
* **Visualization:** `matplotlib` + `FigureCanvasTkAgg` (native UI chart integration).
* **State Management:** JSON (`managers.json`) for team configuration persistence without hardcoding.

## ⚙️ Distribution Algorithm (Under the hood)

The logic (`logic.py`) doesn't just divide rows equally; it solves an optimization problem with Hard & Soft Constraints.

### 1. Target Computation
Uses the **Largest Remainder Method** to accurately distribute target quotas (`target_total`) among managers.
* Accounts for individual employee limits (`cap`).
* Quotas are broken down into sub-targets by tariffs (1, 3, 12 months) proportionally to their global share (`_global_tariff_shares`).

### 2. State Locking
* **Hard Lock:** Paid clients (`paid = 1`) already assigned to support managers are locked and excluded from migration.
* **External Pool:** Clients assigned to non-support managers are forcibly pulled for redistribution.

### 3. Cost Function
Every potential reassignment is evaluated through a penalty system.
* **Tolerances:** Total ±5, Tariffs ±3. Exceeding the tolerance results in a squared penalty.
* **Weights:** Different weights for metrics (`EXTERNAL_PERIOD_WEIGHT`, `INTERNAL_TOTAL_WEIGHT`, etc.) force the algorithm to prioritize balancing the total volume first, and tariffs second.
* **Cap Penalty:** Exceeding a hard limit is penalized by a hyper-coefficient (`1_000_000.0`), preventing employee overload.

### 4. Conservative Rebalance
For distributing unpaid clients within the support department, an iterative approach is used (up to 5000 iterations). A move (donor -> receiver) occurs **only** if it reduces the Global State Score metric. Additionally, a `fairness_penalty` is applied so the algorithm doesn't "drain" the same donors repeatedly.

## 🛠 Key UI Features

* **Manager Editor:** Multi-select, role assignment (`is_support`), and limit adjustments directly from the UI, saved instantly to JSON.
* **Merge from Excel:** Automatic parsing of new names from the uploaded dataset.
* **Real-time Analytics:** *Summary* tab (targets and deltas), *Moves* (migration log), *Checks* (constraints validation), and *Chart* ("fact vs plan" visualization).
* **Excel Export:** Multi-sheet report (output, summary, moves, checks) powered by `openpyxl`.

## 🚀 Installation & Setup

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd kassa_distribution
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
   *(Dependencies: `pandas`, `matplotlib`, `openpyxl`. Note: `tkinter` must be installed at the system level).*
3. Run the application:
   ```bash
   python app.py
   ```

## 📋 Input Dataset Requirements (Excel)
The file must contain the following columns:
* `Менеджер` (string)
* `Тариф` (integer: 1, 3, 12)
* `Оплачен ИНН` (flag: 1 or 0)

🧠 Takeaway

Real-world distribution problems are not about perfect balance.

They are about finding the best possible compromise
between fairness, constraints, and stability.

This tool is built exactly for that.

---

### <a name="русская-версия"></a> 🇷🇺 Русская версия

# Kassa Distribution Tool 📊

Десктопное приложение для интеллектуальной балансировки пула клиентов (касс/сделок) между менеджерами сопровождения. Проект автоматизирует процесс распределения, устраняет ручной overhead и минимизирует миграцию клиентов, используя оптимизационную модель на основе функций штрафов (cost-based optimization).

## 💡 Архитектура и стек
* **Язык:** Python 3.10+
* **Data Processing:** `pandas` (векторизованная обработка данных, группировки).
* **GUI:** `tkinter` + `ttk` (с темой `clam` для чистого интерфейса).
* **Визуализация:** `matplotlib` + `FigureCanvasTkAgg` (интеграция графиков напрямую в интерфейс).
* **Хранение состояния:** JSON (`managers.json`) для персистентности конфигурации команды без хардкода.

## ⚙️ Алгоритм распределения (Under the hood)

Логика (`logic.py`) не просто «раскидывает» строки поровну, а решает задачу оптимизации с жесткими и мягкими ограничениями (Hard & Soft Constraints).

### 1. Вычисление квот (Target Computation)
Используется **Largest Remainder Method** (метод наибольших остатков) для точного распределения целевых значений (`target_total`) между менеджерами.
* Учитываются индивидуальные лимиты сотрудников (`cap`).
* Квоты разбиваются на под-таргеты по тарифам (1, 3, 12 месяцев) пропорционально их глобальной доле (`_global_tariff_shares`).

### 2. Заморозка состояния (State Locking)
* **Hard Lock:** Оплаченные клиенты (`paid = 1`), уже находящиеся у саппорт-менеджеров, аппаратно фиксируются и не участвуют в миграции.
* **Внешний пул:** Клиенты не-саппорт менеджеров принудительно изымаются для распределения.

### 3. Оптимизационная функция (Cost Function)
Каждое потенциальное перемещение оценивается через систему штрафов. 
* **Допуски (Tolerances):** Total ±5, Тарифы ±3. Превышение допуска возводится в квадрат (квадратичный штраф).
* **Весовые коэффициенты:** Разные веса для метрик (`EXTERNAL_PERIOD_WEIGHT`, `INTERNAL_TOTAL_WEIGHT` и др.) заставляют алгоритм приоритетнее выравнивать общую массу, а затем тарифы.
* **Cap Penalty:** Превышение жесткого лимита штрафуется гипер-коэффициентом (`1_000_000.0`), блокируя перегруз сотрудников.

### 4. Консервативный ребаланс
Для распределения неоплаченных клиентов внутри отдела используется итеративный подход (до 5000 итераций). Перемещение (donor -> receiver) происходит **только** если оно снижает метрику глобальной "боли" (`Global State Score`). Дополнительно применяется `fairness_penalty`, чтобы алгоритм не "доил" одних и тех же доноров.

## 🛠 Ключевые фичи интерфейса (UI)

* **Управление командой (Manager Editor):** Массовое выделение (multi-select), назначение ролей (`is_support`) и установка лимитов напрямую из UI с сохранением в JSON.
* **Merge from Excel:** Автоматический парсинг новых имен из загружаемого датасета.
* **Аналитика в реальном времени:** Вкладки *Summary* (сводка таргетов и дельт), *Moves* (лог миграций), *Checks* (валидация констрейнтов) и *Chart* (график "факт vs план").
* **Excel Export:** Многостраничный отчет (output, summary, moves, checks) на базе движка `openpyxl`.

## 🚀 Запуск и установка

1. Клонировать репозиторий:
   ```bash
   git clone <repo-url>
   cd kassa_distribution
   ```
2. Установить зависимости:
   ```bash
   pip install -r requirements.txt
   ```
   *(Зависимости: `pandas`, `matplotlib`, `openpyxl`. Библиотека `tkinter` должна быть установлена на уровне системы).*
3. Запустить приложение:
   ```bash
   python app.py
   ```

## 📋 Требования к входному датасету (Excel)
Обязательное наличие колонок:
* `Менеджер` (строка)
* `Тариф` (число: 1, 3, 12)
* `Оплачен ИНН` (флаг: 1 или 0)

🧠 Основной вывод

Реальные задачи распределения — это не про идеальный баланс.

Они про поиск наилучшего компромисса
между справедливостью, ограничениями и стабильностью.

Этот инструмент создан именно для этого.
