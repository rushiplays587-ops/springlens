package com.shop.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "shop")
public class ShopProperties {
    private String currency;
    private int freeShippingThreshold;
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
}
