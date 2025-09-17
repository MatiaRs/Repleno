document.addEventListener('DOMContentLoaded', () => {
        // =================================================================================
        // --- CAPA DE DATOS Y ESTADO DE LA APLICACIÓN ---
        // =================================================================================
        let products = JSON.parse(localStorage.getItem('products')) || [];
        let sales = JSON.parse(localStorage.getItem('sales')) || [];
        
        const generateBarcodeValue = () => `780${String(Date.now()).slice(-9)}`;

        const initializeProducts = () => {
            if (products.length === 0) {
                 products = [
                    { id: 1, name: "Café de Grano Tostado", price: 12990, stock: 50, image: "/img/Café de Grano Tostado.jpg", barcode: generateBarcodeValue() },
                    { id: 2, name: "Té Verde Matcha Orgánico", price: 15990, stock: 8, image: "/img/Té Verde Matcha Orgánico.jpg", barcode: generateBarcodeValue() },
                    { id: 3, name: "Miel de Ulmo 1kg", price: 8990, stock: 30, image: "/img/Miel de Ulmo 1kg.webp", barcode: generateBarcodeValue() },
                    { id: 4, name: "Aceite de Oliva Extra Virgen", price: 7500, stock: 0, image: "/img/Aceite de Oliva Extra Virgen.webp", barcode: generateBarcodeValue() },
                ];
            }
            products.forEach(p => { if (!p.barcode) p.barcode = generateBarcodeValue(); });
            saveProducts();
        };

        function saveProducts() { localStorage.setItem('products', JSON.stringify(products)); }
        function saveSales() { localStorage.setItem('sales', JSON.stringify(sales)); }

        // =================================================================================
        // --- SELECTORES DE ELEMENTOS DEL DOM ---
        // =================================================================================
        const pageTitle = document.getElementById('pageTitle');
        const pageDescription = document.getElementById('pageDescription');
        const searchInput = document.getElementById('searchInput');
        const inventoryList = document.getElementById('inventory-list');
        const criticalInventoryList = document.getElementById('critical-inventory-list');
        const editProductModal = document.getElementById('editProductModal');
        const multiAddModal = document.getElementById('multi-add-modal');
        const massSellModal = document.getElementById('massSellModal');
        const massAdjustModal = document.getElementById('massAdjustModal');
        const deleteConfirmModal = document.getElementById('deleteConfirmModal');
        const productForm = document.getElementById('productForm');
        const addProductBtn = document.getElementById('addProductBtn');
        const dailyRevenueEl = document.getElementById('daily-revenue');
        const dailySalesEl = document.getElementById('daily-sales');
        const weeklyRevenueEl = document.getElementById('weekly-revenue');
        const monthlyRevenueEl = document.getElementById('monthly-revenue');
        const assistantMessagesEl = document.getElementById('assistant-messages');
        const revenueChartCtx = document.getElementById('revenueChart')?.getContext('2d');
        const topProductsChartCtx = document.getElementById('topProductsChart')?.getContext('2d');
        const menuToggle = document.getElementById('menu-toggle');
        const sidebar = document.querySelector('.sidebar');
        const sidebarOverlay = document.querySelector('.sidebar-overlay');
        const addRowBtn = document.getElementById('add-row-btn');
        const saveMultiAddBtn = document.getElementById('saveMultiAddBtn');
        const sellBtn = document.getElementById('sellBtn');
        const adjustStockBtn = document.getElementById('adjustStockBtn');
        
        let revenueChartInstance, topProductsChartInstance;
        let currentImageBase64 = null;
        let multiAddImageBuffers = {};

        // =================================================================================
        // --- FUNCIONES UTILITARIAS Y DE FORMATO ---
        // =================================================================================
        const formatCurrencyCLP = (value) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(value);
        const calculateTotalRevenue = (salesArray) => salesArray.reduce((sum, s) => sum + ((s.price || 0) * (s.quantity || 0)), 0);

        // =================================================================================
        // --- FUNCIONES DE RENDERIZADO (Actualización de la UI) ---
        // =================================================================================

        const renderProductList = (filter = '') => {
            inventoryList.innerHTML = '';
            let filteredProducts = products;
            if (filter) {
                filteredProducts = products.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()));
            }
            if (filteredProducts.length === 0) {
                inventoryList.innerHTML = `<p style="padding: 1rem; text-align: center;">No se encontraron productos.</p>`;
                return;
            }
            filteredProducts.forEach(product => {
                const stockClass = product.stock === 0 ? 'low' : product.stock < 10 ? 'medium' : '';
                const el = document.createElement('div');
                el.className = 'product-item';
                el.innerHTML = `<img src="${product.image}" alt="${product.name}" class="product-image" onerror="this.src='https://placehold.co/50x50/EFEFEF/333?text=Err'"><div class="product-details"><h3>${product.name}</h3></div><div class="barcode-container"><svg class="barcode" id="barcode-${product.id}-main"></svg></div><span class="product-price">${formatCurrencyCLP(product.price)}</span><span class="product-stock ${stockClass}">${product.stock}</span><div class="product-actions"><button class="action-btn edit" data-id="${product.id}" title="Editar"><i class='bx bxs-edit'></i></button><button class="action-btn delete" data-id="${product.id}" title="Eliminar"><i class='bx bxs-trash'></i></button></div>`;
                inventoryList.appendChild(el);
                if (product.barcode) {
                    try { JsBarcode(`#barcode-${product.id}-main`, product.barcode, { height: 30, displayValue: false, margin: 0 }); } catch (e) {}
                }
            });
        };

        const renderCriticalInventory = () => {
            criticalInventoryList.innerHTML = '';
            const criticalProducts = products.filter(p => p.stock < 10);
            if (criticalProducts.length === 0) {
                criticalInventoryList.innerHTML = `<p style="padding: 1rem 0; text-align: center;">No hay productos con stock crítico.</p>`;
                return;
            }
            criticalProducts.forEach(product => {
                const itemEl = document.createElement('div');
                itemEl.className = 'critical-inventory-item';
                itemEl.innerHTML = `<img src="${product.image}" class="product-image" onerror="this.src='https://placehold.co/50x50/EFEFEF/333?text=Err'"><div>${product.name}</div><input type="number" class="critical-stock-input" value="${product.stock}" data-id="${product.id}" min="0">`;
                criticalInventoryList.appendChild(itemEl);
            });
        };

        const renderDashboard = () => {
            const today = new Date();
            const oneWeekAgo = new Date(); oneWeekAgo.setDate(today.getDate() - 7);
            const isSameDay = (d1, d2) => d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
            const dailySalesData = sales.filter(s => isSameDay(new Date(s.date), today));
            const weeklySalesData = sales.filter(s => new Date(s.date) >= oneWeekAgo);
            const monthlySalesData = sales.filter(s => new Date(s.date).getMonth() === today.getMonth() && new Date(s.date).getFullYear() === today.getFullYear());
            
            dailyRevenueEl.textContent = formatCurrencyCLP(calculateTotalRevenue(dailySalesData));
            weeklyRevenueEl.textContent = formatCurrencyCLP(calculateTotalRevenue(weeklySalesData));
            monthlyRevenueEl.textContent = formatCurrencyCLP(calculateTotalRevenue(monthlySalesData));
            dailySalesEl.textContent = dailySalesData.reduce((sum, s) => sum + (s.quantity || 0), 0);
            
            assistantMessagesEl.innerHTML = '';
            const outOfStockProducts = products.filter(p => p.stock === 0);
            const lowStockProducts = products.filter(p => p.stock > 0 && p.stock < 10);

            if (outOfStockProducts.length > 0) outOfStockProducts.forEach(p => createAssistantMessage(`¡Agotado! "${p.name}" no tiene stock. Reponer urgentemente.`, 'alert'));
            if (lowStockProducts.length > 0) lowStockProducts.forEach(p => createAssistantMessage(`¡Stock bajo! Quedan solo ${p.stock} de "${p.name}".`, 'warning'));
            if (outOfStockProducts.length === 0 && lowStockProducts.length === 0) createAssistantMessage('Todo en orden. No hay alertas de stock.', 'info');
            
            renderCriticalInventory();
        };
        const createAssistantMessage = (text, type) => {
            const msgEl = document.createElement('div');
            msgEl.className = `assistant-msg ${type}`;
            msgEl.innerHTML = `<i class='bx bxs-info-circle'></i> <p>${text}</p>`;
            assistantMessagesEl.appendChild(msgEl);
        };

        const renderAnalysis = () => {
            if (revenueChartInstance) revenueChartInstance.destroy();
            if (topProductsChartInstance) topProductsChartInstance.destroy();
            const last7Days = [...Array(7)].map((_, i) => (d => new Date(d.setDate(d.getDate() - i)))(new Date).toISOString().split('T')[0]).reverse();
            const revenueByDay = last7Days.map(day => calculateTotalRevenue(sales.filter(s => s.date.startsWith(day))));
            const dayLabels = last7Days.map(d => new Date(d + 'T00:00:00').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric'}));
            revenueChartInstance = new Chart(revenueChartCtx, { type: 'bar', data: { labels: dayLabels, datasets: [{ label: 'Ingresos (CLP)', data: revenueByDay, backgroundColor: 'rgba(0, 122, 122, 0.6)', borderColor: 'rgba(0, 122, 122, 1)', borderWidth: 1 }] }, options: { scales: { y: { beginAtZero: true } }, responsive: true, maintainAspectRatio: false } });
            const salesByProduct = sales.reduce((acc, sale) => { acc[sale.productId] = (acc[sale.productId] || 0) + (sale.quantity || 0); return acc; }, {});
            const sortedProducts = Object.entries(salesByProduct).sort(([,a],[,b]) => b - a).slice(0, 5);
            const topProductLabels = sortedProducts.map(([id]) => products.find(p => p.id == id)?.name || 'Eliminado');
            const topProductData = sortedProducts.map(([,qty]) => qty);
            topProductsChartInstance = new Chart(topProductsChartCtx, { type: 'doughnut', data: { labels: topProductLabels, datasets: [{ data: topProductData, backgroundColor: ['#007A7A', '#00A3A3', '#F59E0B', '#DC2626', '#0284C7'] }] }, options: { responsive: true, maintainAspectRatio: false } });
        };
        
        const showModal = (modalEl) => modalEl.classList.add('active');
        const hideModal = (modalEl) => { 
            modalEl.classList.remove('active');
            modalEl.querySelectorAll('form').forEach(f => f.reset());
            if (document.getElementById('imagePreview')) { document.getElementById('imagePreview').style.display = 'none'; }
            currentImageBase64 = null;
        };
        
        document.querySelector('.sidebar-menu').addEventListener('click', (e) => {
            const menuItem = e.target.closest('.menu-item');
            if (!menuItem || !menuItem.dataset.page) return;
            const pageId = menuItem.dataset.page;
            document.querySelectorAll('.menu-item').forEach(item => item.classList.remove('active'));
            menuItem.classList.add('active');
            document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
            document.getElementById(`${pageId}-page`).classList.add('active');
            const titles = { dashboard: { title: 'Bienvenido', desc: 'Resumen de tu negocio.' }, inventory: { title: 'Inventario', desc: 'Gestiona tus productos.' }, analysis: { title: 'Análisis', desc: 'Visualiza el rendimiento.' } };
            pageTitle.textContent = titles[pageId].title; pageDescription.textContent = titles[pageId].desc;
            if (pageId === 'analysis') renderAnalysis();
            if (window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); }
        });

        addProductBtn.addEventListener('click', () => {
            const multiAddTableBody = document.querySelector('#multi-add-table tbody');
            multiAddTableBody.innerHTML = '';
            addNewProductRow();
            showModal(multiAddModal);
        });

        document.getElementById('changeImageBtn').addEventListener('click', () => document.getElementById('productImageFile').click());
        document.getElementById('productImageFile').addEventListener('change', (e) => {
             const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    document.getElementById('imagePreview').src = event.target.result;
                    document.getElementById('imagePreview').style.display = 'block';
                    currentImageBase64 = event.target.result;
                }
                reader.readAsDataURL(file);
            }
        });

        productForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const productId = document.getElementById('productId').value;
            const productName = document.getElementById('productName').value.trim();
            const productData = { name: productName, price: parseFloat(document.getElementById('productPrice').value) };
            const nameExists = products.some(p => p.name.toLowerCase() === productName.toLowerCase() && p.id != productId);
            if(nameExists){ alert('Error: Ya existe un producto con este nombre.'); return; }
            const pIndex = products.findIndex(p => p.id == productId);
            if (pIndex > -1) {
                products[pIndex] = { ...products[pIndex], ...productData, image: currentImageBase64 || products[pIndex].image };
            }
            saveProducts(); renderAll(); hideModal(editProductModal);
        });

        inventoryList.addEventListener('click', (e) => {
            const target = e.target.closest('.action-btn');
            if (!target) return;
            const product = products.find(p => p.id === parseInt(target.dataset.id));
            if (!product) return;
            if (target.classList.contains('edit')) {
                document.getElementById('productId').value = product.id;
                document.getElementById('productName').value = product.name;
                document.getElementById('productPrice').value = product.price;
                document.getElementById('productStock').value = product.stock;
                document.getElementById('imagePreview').src = product.image;
                document.getElementById('imagePreview').style.display = 'block';
                currentImageBase64 = product.image;
                showModal(editProductModal);
            } else if (target.classList.contains('delete')){
                document.getElementById('deleteProductName').textContent = product.name;
                document.getElementById('confirmDeleteBtn').dataset.id = product.id;
                showModal(deleteConfirmModal);
            }
        });
        
        criticalInventoryList.addEventListener('change', (e) => {
            if(e.target.classList.contains('critical-stock-input')) {
                const productId = parseInt(e.target.dataset.id);
                const newStock = parseInt(e.target.value);
                const product = products.find(p => p.id === productId);
                if(product && newStock >= 0) {
                    product.stock = newStock;
                    saveProducts();
                    renderDashboard(); 
                    renderProductList(searchInput.value);
                } else {
                    e.target.value = product.stock; 
                    alert('El stock no puede ser negativo.');
                }
            }
        });
        
        document.getElementById('confirmDeleteBtn').addEventListener('click', (e) => {
            products = products.filter(p => p.id !== parseInt(e.target.dataset.id));
            saveProducts(); renderAll(); hideModal(deleteConfirmModal);
        });
        
        function addNewProductRow() {
            const multiAddTableBody = document.querySelector('#multi-add-table tbody');
            const rowId = `row-${Date.now()}`;
            const newRow = document.createElement('tr');
            newRow.id = rowId;
            newRow.innerHTML = `<td class="image-cell"><label class="btn-secondary" for="img-${rowId}">Subir</label><input type="file" id="img-${rowId}" class="multi-add-img" data-row-id="${rowId}" accept="image/*" style="display:none"></td><td><input type="text" placeholder="Nombre del producto" required></td><td><input type="number" placeholder="10000" min="1" required></td><td><input type="number" placeholder="10" min="0" required></td><td class="action-cell"><button type="button" class="action-btn delete" onclick="document.getElementById('${rowId}').remove()"><i class='bx bxs-trash'></i></button></td>`;
            multiAddTableBody.appendChild(newRow);
        }
        
        document.getElementById('multi-add-table').addEventListener('change', (e) => {
            if(e.target.classList.contains('multi-add-img')) {
                const file = e.target.files[0];
                const rowId = e.target.dataset.rowId;
                if(file) {
                    const reader = new FileReader();
                    reader.onload = (event) => { multiAddImageBuffers[rowId] = event.target.result; };
                    reader.readAsDataURL(file);
                    e.target.previousElementSibling.textContent = 'Cargada';
                    e.target.previousElementSibling.style.borderColor = 'var(--success-color)';
                }
            }
        });
        
        addRowBtn.addEventListener('click', addNewProductRow);
        document.getElementById('cancelMultiAddBtn').addEventListener('click', () => hideModal(multiAddModal));
        saveMultiAddBtn.addEventListener('click', () => {
            const multiAddTableBody = document.querySelector('#multi-add-table tbody');
            const rows = multiAddTableBody.querySelectorAll('tr');
            let newProducts = [];
            let allValid = true;
            let errorMessages = new Set();
            const existingNames = new Set(products.map(p => p.name.toLowerCase()));

            rows.forEach((row, index) => {
                row.style.backgroundColor = '';
                const inputs = row.querySelectorAll('input');
                const nameInput = inputs[1];
                const name = nameInput.value.trim();
                const price = parseFloat(inputs[2].value);
                const stock = parseInt(inputs[3].value, 10);
                if (!name) return;
                const nameExists = existingNames.has(name.toLowerCase()) || newProducts.some(p => p.name.toLowerCase() === name.toLowerCase());

                if (nameExists) {
                    errorMessages.add(`El nombre de producto "${name}" ya existe.`);
                    nameInput.style.borderColor = 'var(--danger-color)'; allValid = false;
                } else { nameInput.style.borderColor = ''; }
                
                if(name && !isNaN(price) && price > 0 && !isNaN(stock) && stock >= 0) {
                    if (!nameExists) newProducts.push({ id: Date.now() + index, name, price, stock, barcode: generateBarcodeValue(), image: multiAddImageBuffers[row.id] || `https://placehold.co/50x50/CCCCCC/333?text=${name.substring(0,2)}` });
                } else {
                    errorMessages.add(`La fila para "${name}" tiene datos inválidos.`); allValid = false;
                }
            });

            if (!allValid) { alert(Array.from(errorMessages).join('\n')); return; }
            if (newProducts.length > 0) { products.push(...newProducts); saveProducts(); renderAll(); }
            hideModal(multiAddModal);
            multiAddImageBuffers = {};
        });
        
        sellBtn.addEventListener('click', () => {
            const listEl = document.getElementById('mass-sell-list');
            listEl.innerHTML = '';
            products.forEach(p => {
                const itemEl = document.createElement('div');
                itemEl.className = 'mass-operation-item';
                itemEl.innerHTML = `<img src="${p.image}" class="product-image" onerror="this.src='https://placehold.co/50x50/EFEFEF/333?text=Err'"><div>${p.name}</div><div class="current-stock">Stock: ${p.stock}</div><input type="number" class="mass-sell-input" data-id="${p.id}" placeholder="0" min="0" max="${p.stock}">`;
                listEl.appendChild(itemEl);
            });
            showModal(massSellModal);
        });

        adjustStockBtn.addEventListener('click', () => {
            const listEl = document.getElementById('mass-adjust-list');
            listEl.innerHTML = '';
            products.forEach(p => {
                const itemEl = document.createElement('div');
                itemEl.className = 'mass-operation-item';
                itemEl.innerHTML = `<img src="${p.image}" class="product-image" onerror="this.src='https://placehold.co/50x50/EFEFEF/333?text=Err'"><div>${p.name}</div><div class="current-stock">Stock: ${p.stock}</div><input type="number" class="mass-adjust-input" data-id="${p.id}" placeholder="0">`;
                listEl.appendChild(itemEl);
            });
            showModal(massAdjustModal);
        });

        document.getElementById('applyMassSellBtn').addEventListener('click', () => {
            const inputs = document.querySelectorAll('.mass-sell-input');
            let allValid = true;
            inputs.forEach(input => {
                const quantity = parseInt(input.value) || 0;
                const product = products.find(p => p.id == input.dataset.id);
                input.style.borderColor = '';
                if(quantity < 0 || quantity > product.stock) {
                    input.style.borderColor = 'var(--danger-color)';
                    allValid = false;
                }
            });
            if (!allValid) { alert('Corrije las cantidades en rojo. No puedes vender más del stock disponible.'); return; }
            inputs.forEach(input => {
                const quantity = parseInt(input.value) || 0;
                if(quantity > 0) {
                    const product = products.find(p => p.id == input.dataset.id);
                    product.stock -= quantity;
                    sales.push({ productId: product.id, price: product.price, quantity: quantity, date: new Date().toISOString() });
                }
            });
            saveProducts(); saveSales(); renderAll(); hideModal(massSellModal);
        });
        
        document.getElementById('applyMassAdjustBtn').addEventListener('click', () => {
            const inputs = document.querySelectorAll('.mass-adjust-input');
             let allValid = true;
            inputs.forEach(input => {
                const adjustment = parseInt(input.value) || 0;
                const product = products.find(p => p.id == input.dataset.id);
                input.style.borderColor = '';
                if(product.stock + adjustment < 0) {
                    input.style.borderColor = 'var(--danger-color)';
                    allValid = false;
                }
            });
            if (!allValid) { alert('Corrije los ajustes en rojo. El stock no puede ser negativo.'); return; }
            inputs.forEach(input => {
                const adjustment = parseInt(input.value) || 0;
                if(adjustment !== 0) {
                    const product = products.find(p => p.id == input.dataset.id);
                    product.stock += adjustment;
                }
            });
            saveProducts(); renderAll(); hideModal(massAdjustModal);
        });


        menuToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
        sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });
        
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.addEventListener('click', e => { if (e.target === modal) hideModal(modal); });
        });
        document.getElementById('cancelEditBtn').addEventListener('click', () => hideModal(editProductModal));
        document.getElementById('cancelMassSellBtn').addEventListener('click', () => hideModal(massSellModal));
        document.getElementById('cancelMassAdjustBtn').addEventListener('click', () => hideModal(massAdjustModal));
        document.getElementById('cancelMultiAddBtn').addEventListener('click', () => hideModal(multiAddModal));
        document.getElementById('cancelDeleteBtn').addEventListener('click', () => hideModal(deleteConfirmModal));
        
        searchInput.addEventListener('input', (e) => renderProductList(e.target.value));

        function renderAll() {
            renderDashboard();
            renderProductList(searchInput.value);
            if (document.getElementById('analysis-page').classList.contains('active')) renderAnalysis();
        }
        
        initializeProducts();
        renderAll();
    });