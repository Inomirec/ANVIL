import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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
