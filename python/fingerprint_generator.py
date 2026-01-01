"""
Device Fingerprint Generator for Telegram Accounts
Generates unique, realistic device fingerprints to avoid detection
"""

import random

# Realistic Android devices with proper models and versions
ANDROID_DEVICES = [
    {"model": "Samsung SM-G991B", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-G998B", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-A525F", "brand": "Samsung", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "Samsung SM-A536B", "brand": "Samsung", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Samsung SM-S911B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Samsung SM-S918B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Samsung SM-A546B", "brand": "Samsung", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi 12", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi 12 Pro", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi 13", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi 13 Pro", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "Xiaomi Redmi Note 12", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi Redmi Note 12 Pro", "brand": "Xiaomi", "versions": ["Android 12", "Android 13"]},
    {"model": "Xiaomi POCO F5", "brand": "Xiaomi", "versions": ["Android 13", "Android 14"]},
    {"model": "OnePlus 9", "brand": "OnePlus", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "OnePlus 9 Pro", "brand": "OnePlus", "versions": ["Android 11", "Android 12", "Android 13"]},
    {"model": "OnePlus 10 Pro", "brand": "OnePlus", "versions": ["Android 12", "Android 13"]},
    {"model": "OnePlus 11", "brand": "OnePlus", "versions": ["Android 13", "Android 14"]},
    {"model": "OnePlus Nord 3", "brand": "OnePlus", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 6", "brand": "Google", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Google Pixel 6 Pro", "brand": "Google", "versions": ["Android 12", "Android 13", "Android 14"]},
    {"model": "Google Pixel 7", "brand": "Google", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 7 Pro", "brand": "Google", "versions": ["Android 13", "Android 14"]},
    {"model": "Google Pixel 8", "brand": "Google", "versions": ["Android 14"]},
    {"model": "Google Pixel 8 Pro", "brand": "Google", "versions": ["Android 14"]},
    {"model": "HUAWEI P40 Pro", "brand": "Huawei", "versions": ["Android 10", "Android 11"]},
    {"model": "HUAWEI P50 Pro", "brand": "Huawei", "versions": ["Android 11", "Android 12"]},
    {"model": "HUAWEI Mate 50 Pro", "brand": "Huawei", "versions": ["Android 12", "Android 13"]},
    {"model": "OPPO Find X5 Pro", "brand": "OPPO", "versions": ["Android 12", "Android 13"]},
    {"model": "OPPO Reno 8 Pro", "brand": "OPPO", "versions": ["Android 12", "Android 13"]},
    {"model": "vivo X80 Pro", "brand": "vivo", "versions": ["Android 12", "Android 13"]},
    {"model": "vivo V27 Pro", "brand": "vivo", "versions": ["Android 13"]},
    {"model": "Realme GT 3", "brand": "Realme", "versions": ["Android 13"]},
    {"model": "Realme 11 Pro+", "brand": "Realme", "versions": ["Android 13"]},
    {"model": "Motorola Edge 40 Pro", "brand": "Motorola", "versions": ["Android 13"]},
    {"model": "Sony Xperia 1 V", "brand": "Sony", "versions": ["Android 13", "Android 14"]},
    {"model": "ASUS ROG Phone 7", "brand": "ASUS", "versions": ["Android 13"]},
    {"model": "Nothing Phone (2)", "brand": "Nothing", "versions": ["Android 13", "Android 14"]},
]

IOS_DEVICES = [
    {"model": "iPhone 11", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 11 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 11 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0"]},
    {"model": "iPhone 12", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 12 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 12 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13 Pro", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 13 Pro Max", "versions": ["iOS 15.0", "iOS 15.5", "iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Plus", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Pro", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 14 Pro Max", "versions": ["iOS 16.0", "iOS 16.5", "iOS 17.0", "iOS 17.2"]},
    {"model": "iPhone 15", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Plus", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Pro", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPhone 15 Pro Max", "versions": ["iOS 17.0", "iOS 17.2", "iOS 17.3"]},
    {"model": "iPad Pro 12.9", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
    {"model": "iPad Pro 11", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
    {"model": "iPad Air", "versions": ["iPadOS 16.0", "iPadOS 16.5", "iPadOS 17.0"]},
]

# Telegram app versions (recent realistic versions)
TELEGRAM_VERSIONS = [
    "10.0.0", "10.0.5", "10.1.0", "10.1.1", "10.1.2", "10.1.3",
    "10.2.0", "10.2.1", "10.2.4", "10.2.6", "10.2.9",
    "10.3.0", "10.3.1", "10.3.2", "10.4.0", "10.4.1", "10.4.2",
    "10.5.0", "10.5.1", "10.6.0", "10.6.1", "10.6.2",
    "10.7.0", "10.8.0", "10.8.1", "10.9.0", "10.9.1",
    "10.10.0", "10.10.1", "10.11.0", "10.12.0", "10.12.1",
    "10.13.0", "10.14.0", "10.14.1", "10.14.2", "10.14.3",
    "11.0.0", "11.0.1", "11.1.0", "11.1.1", "11.2.0", "11.2.1",
]

# Language codes with their system variants
LANGUAGES = [
    {"code": "en", "system": ["en-US", "en-GB", "en-AU", "en-CA", "en-IN"]},
    {"code": "ar", "system": ["ar-SA", "ar-EG", "ar-AE", "ar-KW", "ar-QA"]},
    {"code": "de", "system": ["de-DE", "de-AT", "de-CH"]},
    {"code": "es", "system": ["es-ES", "es-MX", "es-AR", "es-CO"]},
    {"code": "fr", "system": ["fr-FR", "fr-CA", "fr-BE", "fr-CH"]},
    {"code": "it", "system": ["it-IT", "it-CH"]},
    {"code": "pt", "system": ["pt-BR", "pt-PT"]},
    {"code": "ru", "system": ["ru-RU"]},
    {"code": "tr", "system": ["tr-TR"]},
    {"code": "hi", "system": ["hi-IN"]},
    {"code": "id", "system": ["id-ID"]},
    {"code": "ja", "system": ["ja-JP"]},
    {"code": "ko", "system": ["ko-KR"]},
    {"code": "zh", "system": ["zh-CN", "zh-TW", "zh-HK"]},
    {"code": "nl", "system": ["nl-NL", "nl-BE"]},
    {"code": "pl", "system": ["pl-PL"]},
    {"code": "uk", "system": ["uk-UA"]},
    {"code": "fa", "system": ["fa-IR"]},
    {"code": "th", "system": ["th-TH"]},
    {"code": "vi", "system": ["vi-VN"]},
]


def generate_fingerprint(prefer_android: bool = True) -> dict:
    """
    Generate a random, realistic device fingerprint.
    
    Args:
        prefer_android: If True, 80% chance of Android device, 20% iOS
        
    Returns:
        Dictionary with device_model, system_version, app_version, lang_code, system_lang_code
    """
    # Choose platform
    use_android = random.random() < 0.8 if prefer_android else random.random() < 0.5
    
    if use_android:
        device = random.choice(ANDROID_DEVICES)
        device_model = device["model"]
        system_version = random.choice(device["versions"])
    else:
        device = random.choice(IOS_DEVICES)
        device_model = device["model"]
        system_version = random.choice(device["versions"])
    
    # Choose app version
    app_version = random.choice(TELEGRAM_VERSIONS)
    
    # Choose language
    lang = random.choice(LANGUAGES)
    lang_code = lang["code"]
    system_lang_code = random.choice(lang["system"])
    
    return {
        "device_model": device_model,
        "system_version": system_version,
        "app_version": app_version,
        "lang_code": lang_code,
        "system_lang_code": system_lang_code
    }


def generate_batch_fingerprints(count: int, unique: bool = True) -> list:
    """
    Generate multiple fingerprints at once.
    
    Args:
        count: Number of fingerprints to generate
        unique: If True, ensure all fingerprints are unique
        
    Returns:
        List of fingerprint dictionaries
    """
    fingerprints = []
    seen = set()
    
    while len(fingerprints) < count:
        fp = generate_fingerprint()
        
        if unique:
            # Create a hashable key for uniqueness check
            key = (fp["device_model"], fp["system_version"], fp["app_version"], 
                   fp["lang_code"], fp["system_lang_code"])
            if key in seen:
                continue
            seen.add(key)
        
        fingerprints.append(fp)
    
    return fingerprints


if __name__ == "__main__":
    # Test generation
    print("Sample Fingerprints:")
    print("-" * 60)
    for i in range(5):
        fp = generate_fingerprint()
        print(f"{i+1}. {fp['device_model']} | {fp['system_version']} | v{fp['app_version']} | {fp['lang_code']}-{fp['system_lang_code']}")
