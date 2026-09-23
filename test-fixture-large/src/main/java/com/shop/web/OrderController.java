package com.shop.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private final OrderService orderService;

    public OrderController(OrderService orderService) { this.orderService = orderService; }

    @GetMapping("/{id}")
    public Order getOrder(@PathVariable Long id) { return orderService.find(id); }

    @PostMapping
    public Order placeOrder(@RequestBody Order order) { return orderService.place(order); }

    @DeleteMapping("/{id}")
    public void cancelOrder(@PathVariable Long id) { orderService.cancel(id); }
}
