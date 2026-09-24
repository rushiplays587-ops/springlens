package com.shop.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class NotificationService {
    @Value("${notify.webhook}")
    private String webhook;

    @Value("${notify.timeout-seconds:30}")
    private int timeoutSeconds;

    @Value("${notify.retries:3}")
    private int retries;

    @Value("${missing.setting}")
    private String missing;

    public void send(String message) { /* posts message to the webhook */ }
}
