import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Шрифты лежат в сборке: программа работает без интернета.
import '@fontsource-variable/onest'
import '@fontsource-variable/inter'
import './index.css'
import { installTooltips } from './lib/tooltips'

const container = document.getElementById('root')
if (!container) throw new Error('Не найден корневой элемент #root')

// Подсказки при наведении — свои, внутри окна (см. lib/tooltips.ts).
installTooltips()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
