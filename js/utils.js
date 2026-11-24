const drawer = document.querySelector('.drawer');
const resizer = document.querySelector('.drawer-resizer');

let isResizing = false;

// Cuando el usuario hace clic en el borde
resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'ew-resize'; // Mantiene el cursor mientras arrastras
});

// Cuando el usuario mueve el mouse
document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    
    // Calcula el nuevo ancho desde el borde derecho de la pantalla
    const newWidth = document.documentElement.clientWidth - e.clientX;
    const maxWidth = document.documentElement.clientWidth / 2; // Límite: mitad de la pantalla
    const minWidth = 300; // Puedes ajustar el tamaño mínimo permitido
    
    if (newWidth >= minWidth && newWidth <= maxWidth) {
        drawer.style.width = `${newWidth}px`;
    }
});

// Cuando el usuario suelta el clic
document.addEventListener('mouseup', () => {
    if (isResizing) {
        isResizing = false;
        document.body.style.cursor = ''; // Devuelve el cursor a la normalidad
    }
});