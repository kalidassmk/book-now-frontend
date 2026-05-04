/**
 * public/js/scanner-sort.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sorting functionality for the scanner table.
 *
 * Features:
 *   - Multi-column sorting
 *   - Ascending/descending toggle
 *   - Visual sort indicators (↓ ↑)
 *   - Works with dynamic table updates
 */

class ScannerSort {
    constructor() {
        this.sortConfig = { column: 'analysis', direction: 'desc' };
        this.originalData = [];
        this.init();
    }

    init() {
        this.addSortListeners();
        // Show initial indicator for default sort (Analysis Descending)
        this.updateSortIndicators(this.sortConfig.column);
    }

    /**
     * Add click listeners to all table headers
     */
    addSortListeners() {
        const thead = document.querySelector('.scanner-wrap table thead tr');
        if (!thead) return;

        const headers = thead.querySelectorAll('th');
        headers.forEach((th, index) => {
            // Skip the "Action" column
            if (th.textContent.trim() === 'Action') return;

            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
            th.title = 'Click to sort';

            th.addEventListener('click', () => {
                const columnName = th.textContent.trim().toLowerCase();
                this.handleSort(columnName, th);
            });

            // Add hover effect
            th.addEventListener('mouseover', () => {
                if (th.textContent.trim() !== 'Action') {
                    th.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                }
            });
            th.addEventListener('mouseout', () => {
                th.style.backgroundColor = '';
            });
        });
    }

    /**
     * Handle header click for sorting
     */
    handleSort(columnName, headerEl) {
        // Toggle direction if same column clicked
        if (this.sortConfig.column === columnName) {
            this.sortConfig.direction = this.sortConfig.direction === 'desc' ? 'asc' : 'desc';
        } else {
            this.sortConfig.column = columnName;
            this.sortConfig.direction = 'desc';
        }

        // Update visual indicators
        this.updateSortIndicators(columnName);

        // Sort the data
        this.sortTableData();
    }

    /**
     * Update visual sort indicators in headers
     */
    updateSortIndicators(activeColumn) {
        const thead = document.querySelector('.scanner-wrap table thead tr');
        if (!thead) return;

        const headers = thead.querySelectorAll('th');
        headers.forEach(th => {
            const colName = th.textContent.trim().toLowerCase();

            // Remove existing indicators
            const existingIndicator = th.querySelector('.sort-indicator');
            if (existingIndicator) existingIndicator.remove();

            // Add indicator to active column
            if (colName === activeColumn) {
                const indicator = document.createElement('span');
                indicator.className = 'sort-indicator';
                indicator.textContent = this.sortConfig.direction === 'asc' ? ' ↑' : ' ↓';
                indicator.style.marginLeft = '5px';
                indicator.style.color = '#17a2b8';
                indicator.style.fontWeight = 'bold';
                th.appendChild(indicator);
            }
        });
    }

    /**
     * Sort the table data and re-render
     */
    sortTableData() {
        const tbody = document.getElementById('scanner-body');
        if (!tbody) return;

        // Get all rows
        const rows = Array.from(tbody.querySelectorAll('tr'));

        // Sort rows based on column
        rows.sort((rowA, rowB) => {
            const valueA = this.getCellValue(rowA, this.sortConfig.column);
            const valueB = this.getCellValue(rowB, this.sortConfig.column);

            return this.compare(valueA, valueB, this.sortConfig.direction);
        });

        // Re-append sorted rows
        rows.forEach(row => tbody.appendChild(row));
    }

    /**
     * Get the value from a cell for comparison
     */
    getCellValue(row, columnName) {
        let cellIndex = this.getColumnIndex(columnName);
        if (cellIndex === -1) return '';

        const cell = row.cells[cellIndex];
        if (!cell) return '';

        switch (columnName) {
            case 'symbol':
                return cell.querySelector('.sym')?.textContent || '';

            case 'signal':
                return cell.querySelector('.signal-tag')?.textContent || '';

            case 'analysis':
                // Extract score number from badge
                const scoreSpan = cell.querySelector('.score-small');
                if (scoreSpan) {
                    const scoreText = scoreSpan.textContent;
                    const match = scoreText.match(/(\d+)/);
                    return match ? parseFloat(match[1]) : 0;
                }
                return 0;

            case 'price':
                return this.parsePrice(cell.textContent);

            case 'buy @':
                return this.parsePrice(cell.textContent);

            case 'p&l %':
                const pnlText = cell.querySelector('div')?.textContent || '';
                return parseFloat(pnlText.replace('%', '').replace('+', '')) || 0;

            case 'held':
                return this.parseTime(cell.textContent);

            default:
                return cell.textContent;
        }
    }

    /**
     * Get column index by name
     */
    getColumnIndex(columnName) {
        const columnMap = {
            'symbol': 0,
            'signal': 1,
            'analysis': 2,
            'price': 3,
            'buy @': 4,
            'limit price': 5,
            'p&l %': 6,
            'held': 7,
            'action': 8
        };
        return columnMap[columnName] ?? -1;
    }

    /**
     * Parse price string to number
     */
    parsePrice(priceStr) {
        const match = priceStr.match(/[\d.]+/);
        return match ? parseFloat(match[0]) : 0;
    }

    /**
     * Parse time string to milliseconds
     */
    parseTime(timeStr) {
        // Parse formats like "1d 2h 3m" to milliseconds
        let ms = 0;
        const dayMatch = timeStr.match(/(\d+)d/);
        const hourMatch = timeStr.match(/(\d+)h/);
        const minMatch = timeStr.match(/(\d+)m/);
        const secMatch = timeStr.match(/(\d+)s/);

        if (dayMatch) ms += parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
        if (hourMatch) ms += parseInt(hourMatch[1]) * 60 * 60 * 1000;
        if (minMatch) ms += parseInt(minMatch[1]) * 60 * 1000;
        if (secMatch) ms += parseInt(secMatch[1]) * 1000;

        return ms;
    }

    /**
     * Compare two values
     */
    compare(a, b, direction) {
        // Handle numeric comparisons
        if (typeof a === 'number' && typeof b === 'number') {
            return direction === 'asc' ? a - b : b - a;
        }

        // Handle string comparisons
        const aStr = String(a).toLowerCase();
        const bStr = String(b).toLowerCase();

        if (direction === 'asc') {
            return aStr.localeCompare(bStr);
        } else {
            return bStr.localeCompare(aStr);
        }
    }

    /**
     * Sort coins array by specified column
     */
    sortCoins(coins) {
        return coins.sort((a, b) => {
            let valueA, valueB;

            switch (this.sortConfig.column) {
                case 'symbol':
                    valueA = a.symbol || '';
                    valueB = b.symbol || '';
                    break;

                case 'signal':
                    valueA = a.signal || '';
                    valueB = b.signal || '';
                    break;

                case 'analysis':
                    valueA = a.analysisScore || 0;
                    valueB = b.analysisScore || 0;
                    break;

                case 'price':
                    valueA = a.currentPrice || 0;
                    valueB = b.currentPrice || 0;
                    break;

                case 'buy @':
                    valueA = a.buyPrice || 0;
                    valueB = b.buyPrice || 0;
                    break;

                case 'p&l %':
                    valueA = a.pnlPct || 0;
                    valueB = b.pnlPct || 0;
                    break;

                case 'held':
                    valueA = a.heldMs || 0;
                    valueB = b.heldMs || 0;
                    break;

                default:
                    return 0;
            }

            return this.compare(valueA, valueB, this.sortConfig.direction);
        });
    }

    /**
     * Get current sort config
     */
    getConfig() {
        return { ...this.sortConfig };
    }
}

// Initialize scanner sort
const scannerSort = new ScannerSort();

