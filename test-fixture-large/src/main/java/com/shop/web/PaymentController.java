package com.shop.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class PaymentController {
    private final PaymentService paymentService;

    public PaymentController(PaymentService paymentService) { this.paymentService = paymentService; }

    @PostMapping("/api/payments/charge")
    public Receipt charge(@RequestBody ChargeRequest request) { return paymentService.charge(request); }

    @PostMapping("/api/payments/refund")
    public Receipt refund(@RequestBody RefundRequest request) { return paymentService.refund(request); }
}
