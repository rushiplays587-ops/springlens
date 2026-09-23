package com.shop.service;

import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final InventoryService inventoryService;
    private final PaymentService paymentService;

    public OrderService(OrderRepository orderRepository, InventoryService inventoryService, PaymentService paymentService) {
        this.orderRepository = orderRepository;
        this.inventoryService = inventoryService;
        this.paymentService = paymentService;
    }

    public Order place(Order order) {
        inventoryService.reserve(order.getItems());
        paymentService.charge(order.toChargeRequest());
        return orderRepository.save(order);
    }

    public Order find(Long id) { return orderRepository.findById(id).orElseThrow(() -> new NotFoundException("order " + id)); }

    public void cancel(Long id) { orderRepository.deleteById(id); }
}
