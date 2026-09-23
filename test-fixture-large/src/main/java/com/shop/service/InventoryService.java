package com.shop.service;

import org.springframework.stereotype.Service;

@Service
public class InventoryService {
    private final ProductRepository productRepository;

    public InventoryService(ProductRepository productRepository) { this.productRepository = productRepository; }

    public void reserve(java.util.List<OrderItem> items) {
        for (OrderItem item : items) {
            Product p = productRepository.findById(item.getProductId()).orElseThrow();
            p.setStock(p.getStock() - item.getQuantity());
            productRepository.save(p);
        }
    }
}
