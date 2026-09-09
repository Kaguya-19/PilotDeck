import { createInstance } from 'i18next';
import enCommon from './locales/en/common.json';
import zhCommon from './locales/zh-CN/common.json';
import enChat from './locales/en/chat.json';
import zhChat from './locales/zh-CN/chat.json';

// Isolated instance: importing production config also persists language preferences.
export async function createTestI18n(language = 'en') {
  const instance = createInstance();
  await instance.init({ lng: language, fallbackLng: 'en', defaultNS: 'common', resources: {
    en: { common: enCommon, chat: enChat },
    'zh-CN': { common: zhCommon, chat: zhChat },
  }, interpolation: { escapeValue: false } });
  return instance;
}
