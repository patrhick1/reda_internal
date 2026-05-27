import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { Icon } from './Icon';

export type ToastTone = 'ok' | 'error';

export function Toast({
  visible,
  children,
  tone = 'ok',
}: {
  visible: boolean;
  children: React.ReactNode;
  tone?: ToastTone;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: visible ? 1 : 0,
      duration: 280,
      easing: Easing.bezier(0.2, 0.8, 0.2, 1),
      useNativeDriver: true,
    }).start();
  }, [visible, v]);

  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] });
  const opacity = v;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 70,
        left: 16,
        right: 16,
        zIndex: 50,
        opacity,
        transform: [{ translateY }],
      }}
    >
      <View
        style={{
          backgroundColor: colors.black,
          borderRadius: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          shadowColor: colors.black,
          shadowOpacity: 0.25,
          shadowOffset: { width: 0, height: 10 },
          shadowRadius: 30,
          elevation: 8,
        }}
      >
        <Icon
          name={tone === 'ok' ? 'check' : 'alert'}
          size={18}
          color={tone === 'ok' ? colors.success : colors.red}
        />
        {typeof children === 'string' ? (
          <Text style={{ color: colors.white, fontFamily: fonts.semibold, fontSize: 14 }}>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </Animated.View>
  );
}
