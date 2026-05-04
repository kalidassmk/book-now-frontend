/**
 * public/js/layout.js
 * Handles resizable panels and collapsible UI elements.
 */

const layout = {
    isResizing: false,
    lastWidth: 420,

    init() {
        const resizer = document.getElementById('resizer');
        const rightPanel = document.getElementById('right-panel');
        const toggleBtn = document.getElementById('toggle-right');

        if (!resizer || !rightPanel) return;

        // 1. Resizer Logic
        resizer.addEventListener('mousedown', (e) => {
            this.isResizing = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.isResizing) return;

            // Calculate new width (right aligned)
            const newWidth = window.innerWidth - e.clientX;
            
            // Constrain width
            if (newWidth > 100 && newWidth < 800) {
                rightPanel.style.width = `${newWidth}px`;
                this.lastWidth = newWidth;
            }
        });

        document.addEventListener('mouseup', () => {
            if (this.isResizing) {
                this.isResizing = false;
                document.body.style.cursor = 'default';
                document.body.style.userSelect = 'auto';
            }
        });

        // 2. Toggle Button Logic
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const isCollapsed = rightPanel.classList.toggle('collapsed');
                toggleBtn.textContent = isCollapsed ? '▶' : '◀';
                toggleBtn.title = isCollapsed ? 'Expand Terminal' : 'Collapse Terminal';
            });
        }
    }
};

window.layout = layout;
layout.init();
