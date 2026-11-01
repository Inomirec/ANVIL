/**
 * Приписка к имени обработанного файла: «_anvil» и название пресета —
 * «ролик_anvil_баланс.mp4». В папке потом сразу видно, чем сжимали, а
 * не только вес. Формат в приписку не идёт: его и так видно по расширению.
 * Пресет погас (настроили вручную) — только «_anvil».
 */
const PRESET_WORDS: Record<string, string> = {
  pack_quality: 'качество',
  pack_balanced: 'баланс',
  pack_economy: 'экономия',
  pack_h264: 'h264',
  remux_mp4: 'конвертация',
  stream_copy: 'без_сжатия',
  opus_96: 'баланс',
  mp3_192_compat: 'баланс',
}

export function outputSuffix(presetId?: string | null): string {
  const word = presetId ? PRESET_WORDS[presetId] : undefined
  return word ? `_anvil_${word}` : '_anvil'
}
