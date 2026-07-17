import type { Locale } from ".";
import type { OnboardingGoal } from "../onboarding/types";

const en = {
  title: "Start with one useful result",
  intro: "Choose a first goal. Only public data and paper trading are used.",
  monitoringTitle: "Open a chart",
  alertTitle: "Create a price alert",
  backtestTitle: "Run a backtest",
  paperTitle: "Create a paper robot",
  paperDenied: "Paper-trading permission is not available.",
  unavailable: "Unavailable",
  choose: "Choose",
  later: "Do this later",
  retry: "Retry",
  restart: "Getting started",
  documentation: "Documentation",
  monitoringStep: "Wait for chart candles.",
  alertStep: "Add a chart price alert.",
  backtestStep: "Run a backtest.",
  paperStep: "Create a paper robot.",
  loadError: "Guide unavailable. The application remains usable.",
  boundary: "Setup never asks for exchange API keys."
} as const;

export type OnboardingMessageKey = keyof typeof en;

const ru: Record<OnboardingMessageKey, string> = {
  title: "Начните с одного полезного результата",
  intro: "Выберите первую цель. Используются только публичные данные и paper-торговля.",
  monitoringTitle: "Открыть график",
  alertTitle: "Создать ценовой алерт",
  backtestTitle: "Запустить backtest",
  paperTitle: "Создать paper-робота",
  paperDenied: "Доступ к paper-торговле не предоставлен.",
  unavailable: "Недоступно",
  choose: "Выбрать",
  later: "Сделать позже",
  retry: "Повторить",
  restart: "Начало работы",
  documentation: "Документация",
  monitoringStep: "Дождитесь свечей на графике.",
  alertStep: "Добавьте ценовой алерт.",
  backtestStep: "Запустите backtest.",
  paperStep: "Создайте paper-робота.",
  loadError: "Подсказка недоступна. Приложение продолжает работать.",
  boundary: "Настройка не запрашивает API-ключи бирж."
};

const kk: Record<OnboardingMessageKey, string> = {
  title: "Бір пайдалы нәтижеден бастаңыз",
  intro: "Бірінші мақсатты таңдаңыз. Тек ашық деректер мен paper-сауда қолданылады.",
  monitoringTitle: "Графикті ашу",
  alertTitle: "Баға ескертуін жасау",
  backtestTitle: "Backtest іске қосу",
  paperTitle: "Paper-робот жасау",
  paperDenied: "Paper-сауда рұқсаты берілмеген.",
  unavailable: "Қолжетімсіз",
  choose: "Таңдау",
  later: "Кейін жасау",
  retry: "Қайталау",
  restart: "Жұмысты бастау",
  documentation: "Құжаттама",
  monitoringStep: "График шамдарын күтіңіз.",
  alertStep: "Баға ескертуін қосыңыз.",
  backtestStep: "Backtest іске қосыңыз.",
  paperStep: "Paper-робот жасаңыз.",
  loadError: "Нұсқаулық қолжетімсіз. Қолданба жұмысын жалғастырады.",
  boundary: "Баптау биржа API кілттерін сұрамайды."
};

const messages: Record<Locale, Record<OnboardingMessageKey, string>> = { en, ru, kk };

export function onboardingText(locale: Locale, key: OnboardingMessageKey): string {
  return messages[locale][key];
}

export function onboardingGoalText(locale: Locale, goal: OnboardingGoal, kind: "title" | "step"): string {
  const title = kind === "title";
  const key = goal === "monitoring" ? (title ? "monitoringTitle" : "monitoringStep") : goal === "price-alert" ? (title ? "alertTitle" : "alertStep") : goal === "backtest" ? (title ? "backtestTitle" : "backtestStep") : title ? "paperTitle" : "paperStep";
  return onboardingText(locale, key);
}
