import type { Locale } from ".";

const en = {
  openedFilesTitle: "Review files opened by the operating system",
  closeOpenedFiles: "Close opened-file review",
  openedFilesHelp: "SaltanatbotV2 received these files from the operating system. Continue only if you intended to open them here.",
  openedFilesPrivacy: "Contents have not been read yet. Review runs locally; nothing is uploaded, executed or traded.",
  sharedFilesTitle: "Review files shared with SaltanatbotV2",
  closeSharedFiles: "Close shared-file review",
  sharedFilesHelp: "Another app shared these files through the operating system. Continue only if you intended to send them to SaltanatbotV2.",
  sharedFilesPrivacy: "Files are held temporarily on this device. Contents are not parsed until review; nothing is uploaded, executed or traded.",
  sharedFilesExpired: "This shared batch is unavailable or expired. Nothing was imported.",
  filesRejected: "Files not accepted",
  pine: "Pine source",
  strategy: "Strategy artifact",
  plugin: "Plugin package",
  tooMany: "Only the first 10 files can be reviewed at once.",
  unsupported: "Unsupported file extension.",
  tooLarge: "File exceeds its bounded safety limit.",
  unreadable: "The operating system did not provide a readable file.",
  review: "Review files locally",
  reviewing: "Validating locally…",
  cancel: "Cancel"
};

export type PwaMessageKey = keyof typeof en;

const ru: Record<PwaMessageKey, string> = {
  openedFilesTitle: "Проверка файлов, открытых операционной системой",
  closeOpenedFiles: "Закрыть проверку открытых файлов",
  openedFilesHelp: "SaltanatbotV2 получил эти файлы от операционной системы. Продолжайте, только если вы намеренно открыли их в приложении.",
  openedFilesPrivacy: "Содержимое ещё не прочитано. Проверка выполняется локально: ничего не загружается, не исполняется и не торгуется.",
  sharedFilesTitle: "Проверка файлов, переданных в SaltanatbotV2",
  closeSharedFiles: "Закрыть проверку переданных файлов",
  sharedFilesHelp: "Другое приложение передало эти файлы через операционную систему. Продолжайте, только если вы намеренно отправили их в SaltanatbotV2.",
  sharedFilesPrivacy: "Файлы временно хранятся на этом устройстве. Содержимое не разбирается до проверки: ничего не загружается, не исполняется и не торгуется.",
  sharedFilesExpired: "Переданный набор недоступен или истёк. Ничего не импортировано.",
  filesRejected: "Непринятые файлы",
  pine: "Исходник Pine",
  strategy: "Артефакт стратегии",
  plugin: "Пакет плагина",
  tooMany: "Одновременно можно проверить только первые 10 файлов.",
  unsupported: "Расширение файла не поддерживается.",
  tooLarge: "Файл превышает ограниченный безопасный размер.",
  unreadable: "Операционная система не предоставила читаемый файл.",
  review: "Проверить файлы локально",
  reviewing: "Локальная проверка…",
  cancel: "Отмена"
};

const kk: Record<PwaMessageKey, string> = {
  openedFilesTitle: "Операциялық жүйе ашқан файлдарды тексеру",
  closeOpenedFiles: "Ашылған файлдарды тексеруді жабу",
  openedFilesHelp: "SaltanatbotV2 бұл файлдарды операциялық жүйеден алды. Оларды осы қолданбада әдейі ашсаңыз ғана жалғастырыңыз.",
  openedFilesPrivacy: "Мазмұн әлі оқылған жоқ. Тексеру жергілікті орындалады: ештеңе жүктелмейді, орындалмайды және сауда жасалмайды.",
  sharedFilesTitle: "SaltanatbotV2-ге жіберілген файлдарды тексеру",
  closeSharedFiles: "Жіберілген файлдарды тексеруді жабу",
  sharedFilesHelp: "Басқа қолданба бұл файлдарды операциялық жүйе арқылы жіберді. Оларды SaltanatbotV2-ге әдейі жіберсеңіз ғана жалғастырыңыз.",
  sharedFilesPrivacy: "Файлдар осы құрылғыда уақытша сақталады. Тексеруге дейін мазмұн талданбайды: ештеңе жүктелмейді, орындалмайды және сауда жасалмайды.",
  sharedFilesExpired: "Жіберілген файлдар жинағы қолжетімсіз немесе мерзімі аяқталған. Ештеңе импортталмады.",
  filesRejected: "Қабылданбаған файлдар",
  pine: "Pine бастапқы коды",
  strategy: "Стратегия артефактісі",
  plugin: "Плагин пакеті",
  tooMany: "Бір уақытта тек алғашқы 10 файлды тексеруге болады.",
  unsupported: "Файл кеңейтіміне қолдау көрсетілмейді.",
  tooLarge: "Файл шектелген қауіпсіз өлшемнен асады.",
  unreadable: "Операциялық жүйе оқылатын файл бермеді.",
  review: "Файлдарды жергілікті тексеру",
  reviewing: "Жергілікті тексерілуде…",
  cancel: "Болдырмау"
};

const messages: Record<Locale, Record<PwaMessageKey, string>> = { en, ru, kk };

export function pwaText(locale: Locale, key: PwaMessageKey): string {
  return messages[locale][key];
}
