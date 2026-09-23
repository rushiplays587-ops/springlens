package com.shop.service;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class PaymentService {
    private final RestTemplate restTemplate;

    public PaymentService(RestTemplate restTemplate) { this.restTemplate = restTemplate; }

    public Receipt charge(ChargeRequest request) {
        return restTemplate.postForObject("https://gateway.example.com/v1/charges", request, Receipt.class);
    }

    public Receipt refund(RefundRequest request) {
        return restTemplate.postForObject("https://gateway.example.com/v1/refunds", request, Receipt.class);
    }
}
