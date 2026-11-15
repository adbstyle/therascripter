// Mobiles Menü: <details> öffnet und schliesst ohne JavaScript. Hier schliesst es
// zusätzlich nach einem Klick auf einen Link (Anker scrollen sonst unter dem offenen
// Menü weiter), bei einem Klick daneben und mit Escape.
const menu = document.querySelector('.nav-menu')

if (menu) {
  const close = () => menu.removeAttribute('open')

  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) close()
  })

  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) close()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      close()
      menu.querySelector('summary').focus()
    }
  })
}
